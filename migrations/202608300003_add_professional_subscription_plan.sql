ALTER TABLE professional_subscriptions
  DROP CONSTRAINT IF EXISTS professional_subscriptions_effective_plan_check;
ALTER TABLE professional_subscriptions
  ADD CONSTRAINT professional_subscriptions_effective_plan_check
  CHECK (effective_plan IN (
    'COMMUNITY_2_USER_MONTHLY',
    'COMMUNITY_5_USER_MONTHLY',
    'COMMUNITY_10_USER_MONTHLY'
  ));

ALTER TABLE professional_subscriptions
  DROP CONSTRAINT IF EXISTS professional_subscriptions_seat_limit_check;
ALTER TABLE professional_subscriptions
  ADD CONSTRAINT professional_subscriptions_seat_limit_check
  CHECK (seat_limit IN (2, 5, 10));
