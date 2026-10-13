#!/usr/bin/env bash
# Deploy Shop Counter (MCP server, Streamable HTTP) to AWS Lambda arm64 with a public Function URL
# and shopper memory in DynamoDB. NOT run by the build: a person runs it, once, in AWS CloudShell.
#
#   1. On your machine:  cd apps/shop-counter && npm run package        -> dist/function.zip
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
set -euo pipefail

REGION=${AWS_REGION:-us-east-1}
FN=shop-counter
TABLE=${TABLE_NAME:-shop-counter-state}
ROLE=shop-counter-lambda-role
KROLE=shop-counter-killswitch-role
HOURLY_CAP=${HOURLY_CAP:-2000}
CONCURRENCY=${CONCURRENCY:-5}
ALERT_EMAIL=${ALERT_EMAIL:-}
ZIP=${ZIP:-function.zip}
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

echo "== roles (the function may only read/write its own table)"
ensure_role "$ROLE"
ensure_role "$KROLE"
aws iam put-role-policy --role-name "$ROLE" --policy-name shop-counter-state --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":[\"dynamodb:GetItem\",\"dynamodb:PutItem\"],\"Resource\":\"$TABLE_ARN\"}]}"
aws iam put-role-policy --role-name "$KROLE" --policy-name stop-shop-counter --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"lambda:PutFunctionConcurrency\",\"Resource\":\"$FN_ARN\"}]}"

echo "== secret (HMAC for sessions and order confirmations; generated once, kept on re-deploy)"
SECRET=$(aws lambda get-function-configuration --function-name "$FN" \
  --query 'Environment.Variables.SHOP_COUNTER_SECRET' --output text 2>/dev/null || true)
if [ -z "$SECRET" ] || [ "$SECRET" = "None" ]; then SECRET=$(openssl rand -hex 32); fi
ENV="Variables={NODE_ENV=production,SHOP_COUNTER_SECRET=$SECRET,STATE_STORE=dynamodb,TABLE_NAME=$TABLE,SHOP_COUNTER_VIEW_HTML=/var/task/view.html}"

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
CORS='{"AllowOrigins":["*"],"AllowMethods":["GET","POST","DELETE"],"AllowHeaders":["content-type","accept","authorization","mcp-protocol-version","mcp-session-id","last-event-id"],"ExposeHeaders":["mcp-session-id","mcp-protocol-version"],"MaxAge":3600}'
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
import { LambdaClient, PutFunctionConcurrencyCommand } from '@aws-sdk/client-lambda';
export const handler = async () => {
  await new LambdaClient({}).send(new PutFunctionConcurrencyCommand({ FunctionName: '$FN', ReservedConcurrentExecutions: 0 }));
  console.log('shop-counter disabled by kill switch');
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

echo "== smoke test"
curl -s "${URL}health"; echo
curl -s -X POST "${URL}auth/demo-login" -H 'content-type: application/json' -d '{"profile":"guest"}' | head -c 120; echo
echo "DONE  MCP endpoint: ${URL}mcp  (Roborock: ${URL}stores/roborock/mcp)"
echo "Turn it back on after the kill switch: aws lambda delete-function-concurrency --function-name $FN"
