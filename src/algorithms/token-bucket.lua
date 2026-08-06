-- Token Bucket rate limiter (atomic, single round-trip)
--
-- KEYS[1] = bucket hash key, e.g. "sentinel:{route}:{scopeKey}:tb"
--
-- ARGV[1] = capacity (max tokens in bucket)
-- ARGV[2] = refill_rate_per_sec (tokens added per second)
-- ARGV[3] = now_ms (current time in milliseconds, passed in from app to avoid
--           relying on redis server clock skew across a cluster)
-- ARGV[4] = requested (tokens this request costs, normally 1)
-- ARGV[5] = ttl_seconds (key expiry so idle buckets don't leak memory forever)
--
-- Returns: { allowed(1/0), remaining_tokens(int, floored), retry_after_ms }
--
-- Why this has to be one script: a naive implementation does
--   tokens = GET bucket.tokens
--   if tokens > 0: SET bucket.tokens (tokens - 1)
-- That's a read-modify-write with a gap in the middle. Under concurrent
-- requests -- which is the normal case for any service running behind a
-- load balancer with N instances all hitting the same Redis -- two
-- requests can both read "tokens = 1", both decide "allowed", and both
-- decrement, letting 2 requests through a bucket that only had 1 token.
-- Wrapping the whole read-modify-write in a Lua script makes Redis execute
-- it as a single atomic operation; no other command (from any client, on
-- any app instance) can interleave.

local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill_rate = tonumber(ARGV[2])
local now_ms = tonumber(ARGV[3])
local requested = tonumber(ARGV[4])
local ttl_seconds = tonumber(ARGV[5])

local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local last_ts = tonumber(data[2])

if tokens == nil then
  tokens = capacity
  last_ts = now_ms
end

-- Refill based on elapsed time since last touch.
local elapsed_ms = math.max(0, now_ms - last_ts)
local refill = (elapsed_ms / 1000.0) * refill_rate
tokens = math.min(capacity, tokens + refill)

local allowed = 0
local retry_after_ms = 0

if tokens >= requested then
  tokens = tokens - requested
  allowed = 1
else
  -- how long until enough tokens accumulate
  local deficit = requested - tokens
  if refill_rate > 0 then
    retry_after_ms = math.ceil((deficit / refill_rate) * 1000)
  else
    retry_after_ms = -1 -- refill_rate is 0, will never refill
  end
end

redis.call('HMSET', key, 'tokens', tostring(tokens), 'ts', tostring(now_ms))
redis.call('EXPIRE', key, ttl_seconds)

return { allowed, math.floor(tokens), retry_after_ms }
