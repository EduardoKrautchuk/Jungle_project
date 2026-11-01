#!/bin/sh
set -eu

MAIN_QUEUE="${SQS_WAGER_QUEUE_NAME:-wager-transactions.fifo}"
DEAD_LETTER_QUEUE="${SQS_WAGER_DLQ_NAME:-wager-transactions-dlq.fifo}"
EVENTS_QUEUE="${SQS_EVENTS_QUEUE_NAME:-wager-events.fifo}"
EVENTS_DEAD_LETTER_QUEUE="${SQS_EVENTS_DLQ_NAME:-wager-events-dlq.fifo}"
MAX_RECEIVE_COUNT="${SQS_MAX_RECEIVE_COUNT:-5}"
VISIBILITY_TIMEOUT="${SQS_VISIBILITY_TIMEOUT_SECONDS:-30}"

ensure_pair() {
  queue="$1"
  dead_letter_queue="$2"

  awslocal sqs create-queue \
    --queue-name "$dead_letter_queue" \
    --attributes FifoQueue=true,ContentBasedDeduplication=false,MessageRetentionPeriod=1209600 \
    >/dev/null

  dead_letter_url="$(awslocal sqs get-queue-url --queue-name "$dead_letter_queue" --query QueueUrl --output text)"
  dead_letter_arn="$(awslocal sqs get-queue-attributes --queue-url "$dead_letter_url" --attribute-names QueueArn --query Attributes.QueueArn --output text)"

  cat > /tmp/queue-attributes.json <<JSON
{
  "FifoQueue": "true",
  "ContentBasedDeduplication": "false",
  "VisibilityTimeout": "${VISIBILITY_TIMEOUT}",
  "ReceiveMessageWaitTimeSeconds": "20",
  "MessageRetentionPeriod": "345600",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"${dead_letter_arn}\",\"maxReceiveCount\":\"${MAX_RECEIVE_COUNT}\"}"
}
JSON

  awslocal sqs create-queue \
    --queue-name "$queue" \
    --attributes file:///tmp/queue-attributes.json \
    >/dev/null

  queue_url="$(awslocal sqs get-queue-url --queue-name "$queue" --query QueueUrl --output text)"
  awslocal sqs set-queue-attributes \
    --queue-url "$queue_url" \
    --attributes file:///tmp/queue-attributes.json

  echo "queue ready: $queue -> $dead_letter_queue (maxReceiveCount=$MAX_RECEIVE_COUNT)"
}

ensure_pair "$MAIN_QUEUE" "$DEAD_LETTER_QUEUE"
ensure_pair "$EVENTS_QUEUE" "$EVENTS_DEAD_LETTER_QUEUE"
