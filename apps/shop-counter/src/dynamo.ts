/**
 * Shopper state in DynamoDB, for AWS Lambda (where /tmp dies with the container).
 * One item per key: { pk, doc, ver }. Writes are optimistic: read (consistent), apply, put only if
 * `ver` is still what we read; on a race, re-read and retry. On-demand billing, no indexes.
 * ("state" is a DynamoDB reserved word, hence `doc`.)
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { emptyState, type ShopperState, type StateStore } from 'shelf-to-alexa';

/** The one method we use, so tests can pass a fake. */
export interface DocSender {
  send(command: GetCommand | PutCommand): Promise<unknown>;
}

const MAX_TRIES = 5;

function withDefaults(s: Partial<ShopperState> | undefined): ShopperState {
  const e = emptyState();
  return {
    closet: { devices: s?.closet?.devices ?? e.closet.devices, home: s?.closet?.home ?? e.closet.home },
    orders: s?.orders ?? [],
    tickets: s?.tickets ?? [],
    used_tokens: s?.used_tokens ?? {},
  };
}

export class DynamoDbStateStore implements StateStore {
  constructor(private readonly db: DocSender, private readonly table: string) {}

  static create(table: string): DynamoDbStateStore {
    const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    return new DynamoDbStateStore(doc, table);
  }

  private async read(pk: string): Promise<{ state: ShopperState; ver: number }> {
    const out = (await this.db.send(new GetCommand({ TableName: this.table, Key: { pk }, ConsistentRead: true }))) as {
      Item?: { doc?: Partial<ShopperState>; ver?: number };
    };
    return { state: withDefaults(out.Item?.doc), ver: out.Item?.ver ?? 0 };
  }

  async get(userId: string): Promise<ShopperState> {
    return (await this.read(userId)).state;
  }

  async update(userId: string, fn: (s: ShopperState) => ShopperState | Promise<ShopperState>): Promise<ShopperState> {
    for (let attempt = 1; ; attempt++) {
      const { state, ver } = await this.read(userId);
      const next = await fn(state);
      try {
        await this.db.send(
          new PutCommand({
            TableName: this.table,
            Item: { pk: userId, doc: JSON.parse(JSON.stringify(next)), ver: ver + 1, updated_at: new Date().toISOString() },
            ConditionExpression: 'attribute_not_exists(pk) OR #v = :v',
            ExpressionAttributeNames: { '#v': 'ver' },
            ExpressionAttributeValues: { ':v': ver },
          }),
        );
        return next;
      } catch (err) {
        if ((err as { name?: string }).name !== 'ConditionalCheckFailedException' || attempt >= MAX_TRIES) throw err;
      }
    }
  }
}
