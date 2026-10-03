UPDATE alert_subscribers
SET delivery_mode='DAILY', updated_at=now()
WHERE delivery_mode='IMMEDIATE';
