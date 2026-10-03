-- Only durable DM native delivery uses these claims. MCP receipts are independent.
ALTER TABLE notification_queue ADD COLUMN delivery_lease_token TEXT;
ALTER TABLE notification_queue ADD COLUMN delivery_lease_until INTEGER;
