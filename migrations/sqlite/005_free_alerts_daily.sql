UPDATE alert_subscribers
SET delivery_mode='DAILY', updated_at=CURRENT_TIMESTAMP
WHERE delivery_mode='IMMEDIATE';
