#!/usr/bin/env bash
# Deploy Shop Counter (MCP server, Streamable HTTP) to AWS Lambda arm64 with a public Function URL
# and shopper memory in DynamoDB. NOT run by the build: a person runs it, once, in AWS CloudShell.
# The same function also serves the Echo Show simulator at /sim/ and its "Alexa brain" at /brain/...:
# Claude Haiku 5.5 on Amazon Bedrock with the function's IAM role (no API keys), or Amazon Nova Lite
# (BRAIN_PROVIDER=nova), or no model at all (BRAIN_PROVIDER=off, the simulator's keyword router answers).
#
#   1. On your machine:  cd apps/shop-counter && npm run package        -> dist/function.zip (+ /sim/ inside)
#   2. CloudShell:       Actions -> Upload file: dist/function.zip and deploy/deploy_lambda.sh
#   3. CloudShell:       ALERT_EMAIL=you@example.com bash deploy_lambda.sh
#   Re-run the same command to ship a new function.zip (the secret and the table are kept).
#
# Cost, by design inside the AWS free allowances for a hackathon demo:
#   Lambda 1M requests + 400k GB-s / month (256 MB here), DynamoDB on-demand (25 GB storage free,
#   a few cents per million writes), CloudWatch 10 alarms + 5 GB logs, SNS 1M publishes.
#   Guards: reserved concurrency 5 when the account allows it, and a kill switch: more than $HOURLY_CAP invocations in an hour
#   -> CloudWatch alarm -> SNS -> tiny Lambda sets concurrency to 0 (server off until you re-run this).
#   The $1 budget alert already exists in the account.
#   Bedrock (the only part that is not free): the brain stops itself at DAILY_LIMIT_USD (default $0.50/day,
#   counted in DynamoDB) and at BRAIN_IP_TURNS_PER_HOUR (default 60) per caller IP. Over a limit the simulator
#   falls back to its keyword router, so the demo keeps working. A model turn costs about $0.001.
set -euo pipefail

REGION=${AWS_REGION:-us-east-1}
FN=shop-counter
TABLE=${TABLE_NAME:-shop-counter-state}
ROLE=shop-counter-lambda-role
KROLE=shop-counter-killswitch-role
# Kill switch threshold. Was 2000 when the function only served /mcp. Now one judge session also loads the
# simulator page (index, js, css), checks the brain, signs in, and every spoken request is 1-3 brain turns plus
# 1-3 MCP calls: about 100 invocations for a 20-request session. 6000/hour leaves room for ~50 such sessions in
# one hour; 15000 keeps the endpoint up through a busy judging hour. Worst case at the cap all day stays inside Lambda's free 1M requests/month for about a week, and
# Bedrock spend is capped separately by DAILY_LIMIT_USD.
HOURLY_CAP=${HOURLY_CAP:-15000}
# Early warning (email only, nothing stops): at 2000/hour you hear about it long before the kill switch.
WARN_CAP=${WARN_CAP:-2000}
CONCURRENCY=${CONCURRENCY:-5}
ALERT_EMAIL=${ALERT_EMAIL:-}
ZIP=${ZIP:-function.zip}
# claude-api: Claude Haiku 5.5 through the Anthropic API from this Lambda. The default since 2026-10-13: this
# account gets "not available for this account" for every model on Bedrock (Claude and others), as other new
# hackathon accounts reported. The key is NOT in this script: paste ANTHROPIC_API_KEY once in the Lambda console
# (Configuration > Environment variables); every re-deploy reads it back and keeps it, like the HMAC secret.
BRAIN_PROVIDER=${BRAIN_PROVIDER:-claude-api}           # claude-api | anthropic (Bedrock) | nova (Bedrock) | off
CLAUDE_API_MODEL=${CLAUDE_API_MODEL:-claude-haiku-5-5}
ANTHROPIC_MODEL=${ANTHROPIC_MODEL:-anthropic.claude-haiku-5-5}   # Claude in Amazon Bedrock (bedrock-mantle)
NOVA_MODEL=${NOVA_MODEL:-amazon.nova-lite-v1:0}                  # Bedrock Converse
DAILY_LIMIT_USD=${DAILY_LIMIT_USD:-0.50}
BRAIN_IP_TURNS_PER_HOUR=${BRAIN_IP_TURNS_PER_HOUR:-60}
BRAIN_IAM_STRICT=${BRAIN_IAM_STRICT:-1}               # 1: Bedrock only for ANTHROPIC_MODEL; 0: any model, if 1 is denied
case "$BRAIN_PROVIDER" in claude-api) BRAIN_MODEL=$CLAUDE_API_MODEL ;; anthropic) BRAIN_MODEL=$ANTHROPIC_MODEL ;; nova) BRAIN_MODEL=$NOVA_MODEL ;; *) BRAIN_MODEL=none ;; esac
[ -f "$ZIP" ] || { echo "missing $ZIP (run: npm run package, then upload dist/function.zip)"; exit 1; }
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
export AWS_DEFAULT_REGION=$REGION
TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
FN_ARN="arn:aws:lambda:$REGION:$ACCOUNT:function:$FN"
TABLE_ARN="arn:aws:dynamodb:$REGION:$ACCOUNT:table/$TABLE"

ensure_role() {  # name
  if ! aws iam get-role --role-name "$1" >/dev/null 2>&1; then
    aws iam create-role --role-name "$1" --assume-role-policy-document "$TRUST" >/dev/null
    aws iam attach-role-policy --role-name "$1" \
      --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
    echo "created role $1"; sleep 10   # IAM propagation
  fi
}

echo "== DynamoDB table $TABLE (on-demand, one item per shopper key)"
if ! aws dynamodb describe-table --table-name "$TABLE" >/dev/null 2>&1; then
  aws dynamodb create-table --table-name "$TABLE" --billing-mode PAY_PER_REQUEST \
    --attribute-definitions AttributeName=pk,AttributeType=S --key-schema AttributeName=pk,KeyType=HASH >/dev/null
  aws dynamodb wait table-exists --table-name "$TABLE"
fi
# brain counters (brain:<day>, brain-ip:<ip hash>:<hour>) carry expires_at, so DynamoDB deletes them by itself
if [ "$(aws dynamodb describe-time-to-live --table-name "$TABLE" --query 'TimeToLiveDescription.TimeToLiveStatus' --output text)" = "DISABLED" ]; then
  aws dynamodb update-time-to-live --table-name "$TABLE" --time-to-live-specification Enabled=true,AttributeName=expires_at >/dev/null
fi

echo "== roles (the function may only read/write its own table and call the brain's Bedrock models)"
ensure_role "$ROLE"
ensure_role "$KROLE"
aws iam put-role-policy --role-name "$ROLE" --policy-name shop-counter-state --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\",\"dynamodb:UpdateItem\"],\"Resource\":\"$TABLE_ARN\"}]}"
# Claude in Amazon Bedrock is authorized as bedrock-mantle:CreateInference on the account's default project,
# narrowed to one model by the bedrock-mantle:Model condition key. Nova goes through bedrock-runtime Converse,
# which is authorized as bedrock:InvokeModel on that one foundation model. No streaming, so no
# InvokeModelWithResponseStream.
if [ "$BRAIN_IAM_STRICT" = "1" ]; then
  MANTLE="{\"Effect\":\"Allow\",\"Action\":\"bedrock-mantle:CreateInference\",\"Resource\":\"arn:aws:bedrock-mantle:$REGION:$ACCOUNT:project/default\",\"Condition\":{\"StringEquals\":{\"bedrock-mantle:Model\":\"$ANTHROPIC_MODEL\"}}}"
else
  MANTLE="{\"Effect\":\"Allow\",\"Action\":\"bedrock-mantle:CreateInference\",\"Resource\":\"arn:aws:bedrock-mantle:$REGION:$ACCOUNT:project/*\"}"
fi
NOVA="{\"Effect\":\"Allow\",\"Action\":\"bedrock:InvokeModel\",\"Resource\":\"arn:aws:bedrock:$REGION::foundation-model/$NOVA_MODEL\"}"
aws iam put-role-policy --role-name "$ROLE" --policy-name shop-counter-brain --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[$MANTLE,$NOVA]}"
aws iam put-role-policy --role-name "$KROLE" --policy-name stop-shop-counter --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"lambda:PutFunctionConcurrency\",\"lambda:DeleteFunctionConcurrency\",\"lambda:GetFunctionConcurrency\"],\"Resource\":\"$FN_ARN\"},{\"Effect\":\"Allow\",\"Action\":\"cloudwatch:DescribeAlarms\",\"Resource\":\"*\"}]}"

echo "== secret (HMAC for sessions and order confirmations; generated once, kept on re-deploy)"
SECRET=$(aws lambda get-function-configuration --function-name "$FN" \
  --query 'Environment.Variables.SHOP_COUNTER_SECRET' --output text 2>/dev/null || true)
if [ -z "$SECRET" ] || [ "$SECRET" = "None" ]; then SECRET=$(openssl rand -hex 32); fi
# Anthropic API key for BRAIN_PROVIDER=claude-api: set by hand in the console, read back here, never printed.
APIKEY=$(aws lambda get-function-configuration --function-name "$FN" \
  --query 'Environment.Variables.ANTHROPIC_API_KEY' --output text 2>/dev/null || true)
if [ -z "$APIKEY" ] || [ "$APIKEY" = "None" ]; then APIKEY_VAR=""; echo "   no ANTHROPIC_API_KEY on the function yet (brain answers fallback until it is added in the console)"; else APIKEY_VAR=",ANTHROPIC_API_KEY=$APIKEY"; fi
ENV="Variables={NODE_ENV=production,SHOP_COUNTER_SECRET=$SECRET,STATE_STORE=dynamodb,TABLE_NAME=$TABLE,SHOP_COUNTER_VIEW_HTML=/var/task/view.html,BRAIN_PROVIDER=$BRAIN_PROVIDER,BRAIN_MODEL=$BRAIN_MODEL,BRAIN_REGION=$REGION,DAILY_LIMIT_USD=$DAILY_LIMIT_USD,BRAIN_IP_TURNS_PER_HOUR=$BRAIN_IP_TURNS_PER_HOUR$APIKEY_VAR}"

echo "== function (nodejs22.x, arm64, 256 MB, 30 s)"
if aws lambda get-function --function-name "$FN" >/dev/null 2>&1; then
  aws lambda update-function-code --function-name "$FN" --zip-file "fileb://$ZIP" >/dev/null
  aws lambda wait function-updated --function-name "$FN"
  aws lambda update-function-configuration --function-name "$FN" --memory-size 256 --timeout 30 --environment "$ENV" >/dev/null
else
  aws lambda create-function --function-name "$FN" --runtime nodejs22.x --architectures arm64 \
    --handler lambda.handler --role "arn:aws:iam::$ACCOUNT:role/$ROLE" --zip-file "fileb://$ZIP" \
    --memory-size 256 --timeout 30 --environment "$ENV" >/dev/null
fi
aws lambda wait function-updated --function-name "$FN" 2>/dev/null || aws lambda wait function-active --function-name "$FN"
if ! aws lambda put-function-concurrency --function-name "$FN" --reserved-concurrent-executions "$CONCURRENCY" >/dev/null 2>&1; then
  # New accounts have a 10-execution account limit and must keep 10 unreserved, so no reservation is possible.
  # The kill switch still works: it sets reserved concurrency to 0 (that never lowers the unreserved pool).
  aws lambda delete-function-concurrency --function-name "$FN" >/dev/null 2>&1 || true
  echo "reserved concurrency skipped (account limit); kill switch still active"
fi

echo "== logs: keep 14 days"
aws logs create-log-group --log-group-name "/aws/lambda/$FN" 2>/dev/null || true
aws logs put-retention-policy --log-group-name "/aws/lambda/$FN" --retention-in-days 14

echo "== public HTTPS Function URL (CORS lets a browser MCP client send the session header)"
CORS='{"AllowOrigins":["*"],"AllowMethods":["GET","POST","DELETE"],"AllowHeaders":["content-type","accept","authorization","mcp-protocol-version","mcp-session-id","last-event-id"],"ExposeHeaders":["mcp-session-id","mcp-protocol-version","www-authenticate"],"MaxAge":3600}'
if ! aws lambda get-function-url-config --function-name "$FN" >/dev/null 2>&1; then
  aws lambda create-function-url-config --function-name "$FN" --auth-type NONE --cors "$CORS" >/dev/null
  aws lambda add-permission --function-name "$FN" --statement-id public-url \
    --action lambda:InvokeFunctionUrl --principal '*' --function-url-auth-type NONE >/dev/null
  aws lambda add-permission --function-name "$FN" --statement-id public-url-invoke \
    --action lambda:InvokeFunction --principal '*' --invoked-via-function-url >/dev/null 2>&1 || true
else
  aws lambda update-function-url-config --function-name "$FN" --cors "$CORS" >/dev/null
fi
URL=$(aws lambda get-function-url-config --function-name "$FN" --query FunctionUrl --output text)

echo "== kill switch (> $HOURLY_CAP invocations/hour -> concurrency 0)"
cat > /tmp/killswitch.mjs <<JS
import { LambdaClient, PutFunctionConcurrencyCommand, DeleteFunctionConcurrencyCommand, GetFunctionConcurrencyCommand } from '@aws-sdk/client-lambda';
import { CloudWatchClient, DescribeAlarmsCommand } from '@aws-sdk/client-cloudwatch';
const lambda = new LambdaClient({});
export const handler = async (event) => {
  // Hourly schedule (EventBridge): switch the server back on once the hourly alarm is calm again,
  // so a burst during judging costs at most about an hour of downtime, not the rest of the period.
  if (event?.source === 'aws.events' || event?.revive) {
    const c = await lambda.send(new GetFunctionConcurrencyCommand({ FunctionName: '$FN' }));
    if (c.ReservedConcurrentExecutions !== 0) return 'running';
    const a = await new CloudWatchClient({}).send(new DescribeAlarmsCommand({ AlarmNames: ['shop-counter-hourly-cap'] }));
    if (a.MetricAlarms?.[0]?.StateValue === 'ALARM') return 'still busy';
    await lambda.send(new DeleteFunctionConcurrencyCommand({ FunctionName: '$FN' }));
    console.log('shop-counter re-enabled by the hourly check');
    return 'revived';
  }
  await lambda.send(new PutFunctionConcurrencyCommand({ FunctionName: '$FN', ReservedConcurrentExecutions: 0 }));
  console.log('shop-counter disabled by kill switch');
  return 'stopped';
};
JS
(cd /tmp && rm -f killswitch.zip && zip -q killswitch.zip killswitch.mjs)
if ! aws lambda get-function --function-name shop-counter-killswitch >/dev/null 2>&1; then
  aws lambda create-function --function-name shop-counter-killswitch --runtime nodejs22.x --architectures arm64 \
    --handler killswitch.handler --role "arn:aws:iam::$ACCOUNT:role/$KROLE" --zip-file fileb:///tmp/killswitch.zip \
    --timeout 10 --memory-size 128 >/dev/null
fi
TOPIC=$(aws sns create-topic --name shop-counter-killswitch --query TopicArn --output text)
KARN="arn:aws:lambda:$REGION:$ACCOUNT:function:shop-counter-killswitch"
aws lambda add-permission --function-name shop-counter-killswitch --statement-id sns-invoke \
  --action lambda:InvokeFunction --principal sns.amazonaws.com --source-arn "$TOPIC" >/dev/null 2>&1 || true
aws sns subscribe --topic-arn "$TOPIC" --protocol lambda --notification-endpoint "$KARN" >/dev/null
if [ -n "$ALERT_EMAIL" ] && ! aws sns list-subscriptions-by-topic --topic-arn "$TOPIC" \
    --query "Subscriptions[?Endpoint=='$ALERT_EMAIL']" --output text | grep -q .; then
  aws sns subscribe --topic-arn "$TOPIC" --protocol email --notification-endpoint "$ALERT_EMAIL" >/dev/null
fi
aws cloudwatch put-metric-alarm --alarm-name shop-counter-hourly-cap \
  --namespace AWS/Lambda --metric-name Invocations --dimensions Name=FunctionName,Value=$FN \
  --statistic Sum --period 3600 --evaluation-periods 1 --threshold "$HOURLY_CAP" \
  --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching --alarm-actions "$TOPIC"

echo "== early warning (> $WARN_CAP invocations/hour -> email only) and hourly auto re-enable"
WTOPIC=$(aws sns create-topic --name shop-counter-warning --query TopicArn --output text)
if [ -n "$ALERT_EMAIL" ] && ! aws sns list-subscriptions-by-topic --topic-arn "$WTOPIC" \
    --query "Subscriptions[?Endpoint=='$ALERT_EMAIL']" --output text | grep -q .; then
  aws sns subscribe --topic-arn "$WTOPIC" --protocol email --notification-endpoint "$ALERT_EMAIL" >/dev/null
fi
aws cloudwatch put-metric-alarm --alarm-name shop-counter-hourly-warning \
  --namespace AWS/Lambda --metric-name Invocations --dimensions Name=FunctionName,Value=$FN \
  --statistic Sum --period 3600 --evaluation-periods 1 --threshold "$WARN_CAP" \
  --comparison-operator GreaterThanThreshold --treat-missing-data notBreaching --alarm-actions "$WTOPIC"
aws lambda update-function-code --function-name shop-counter-killswitch --zip-file fileb:///tmp/killswitch.zip >/dev/null
RULE_ARN=$(aws events put-rule --name shop-counter-revive --schedule-expression 'rate(1 hour)' --query RuleArn --output text)
aws lambda add-permission --function-name shop-counter-killswitch --statement-id events-revive \
  --action lambda:InvokeFunction --principal events.amazonaws.com --source-arn "$RULE_ARN" >/dev/null 2>&1 || true
aws events put-targets --rule shop-counter-revive --targets "Id=revive,Arn=$KARN" >/dev/null

echo "== smoke test"
curl -s "${URL}health"; echo
curl -s -X POST "${URL}auth/demo-login" -H 'content-type: application/json' -d '{"profile":"guest"}' | head -c 120; echo
echo "simulator page: HTTP $(curl -s -o /dev/null -w '%{http_code}' "${URL}sim/")"
curl -s "${URL}brain/health"; echo
echo "one real brain turn (about \$0.001; 200 = the model answered, 503 + api_error = see DEPLOY.md troubleshooting):"
curl -s -w '\nHTTP %{http_code}\n' -X POST "${URL}brain/turn" -H 'content-type: application/json' \
  -d '{"messages":[{"role":"user","content":"Say hello in five words."}],"tools":[]}' | head -c 400; echo
echo "DONE  MCP endpoint: ${URL}mcp  (Roborock: ${URL}stores/roborock/mcp)"
echo "      Try it in a browser: ${URL}sim/"
echo "Kill switch turns it back on by itself within an hour of calm; by hand: aws lambda delete-function-concurrency --function-name $FN"
