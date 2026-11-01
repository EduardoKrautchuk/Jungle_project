#!/bin/sh
set -eu

MAIN_QUEUE="${SQS_WAGER_QUEUE_NAME:-wager-transactions.fifo}"
DEAD_LETTER_QUEUE="${SQS_WAGER_DLQ_NAME:-wager-transactions-dlq.fifo}"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"
VISIBILITY_TIMEOUT="${SQS_VISIBILITY_TIMEOUT_SECONDS:-30}"

awslocal sqs create-queue \
  --queue-name "$DEAD_LETTER_QUEUE" \
  --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600 \
  >/dev/null

DEAD_LETTER_URL="$(awslocal sqs get-queue-url --queue-name "$DEAD_LETTER_QUEUE" --query QueueUrl --output text)"
DEAD_LETTER_ARN="$(awslocal sqs get-queue-attributes --queue-url "$DEAD_LETTER_URL" --attribute-names QueueArn --query Attributes.QueueArn --output text)"

cat > /tmp/wager-queue-attributes.json <<JSON
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "${VISIBILITY_TIMEOUT}",
  "ReceiveMessageWaitTimeSeconds": "20",
  "MessageRetentionPeriod": "345600",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${DEAD_LETTER_ARN}\",\"maxReceiveCount\":\"${MAX_RECEIVE_COUNT}\"}"
}
JSON

awslocal sqs create-queue \
  --queue-name "$MAIN_QUEUE" \
  --attributes file:///tmp/wager-queue-attributes.json \
  >/dev/null

MAIN_URL="$(awslocal sqs get-queue-url --queue-name "$MAIN_QUEUE" --query QueueUrl --output text)"
awslocal sqs set-queue-attributes \
  --queue-url "$MAIN_URL" \
  --attributes file:///tmp/wager-queue-attributes.json

echo "wager queues ready: $MAIN_QUEUE -> $DEAD_LETTER_QUEUE (maxReceiveCount=$MAX_RECEIVE_COUNT)"
