-- Sliding Window Log rate limiter (atomic, single round-trip)
--
-- Most accurate of the three algorithms: keeps a timestamp per request in a
-- Redis sorted set (score = timestamp, member = unique request id), trims
-- everything outside the trailing window, and counts what's left. No
-- boundary artifacts like fixed-window counters have (no burst-at-the-edge
-- problem), at the cost of O(window_size) memory per key instead of O(1).
--
-- KEYS[1] = zset key, e.g. "sentinel:{route}:{scopeKey}:swl"
--
-- ARGV[1] = now_ms
-- ARGV[2] = window_ms
-- ARGV[3] = limit
-- ARGV[4] = member id (must be unique per request -- caller generates e.g.
--           `${now_ms}-${random}` so concurrent requests in the same
--           millisecond don't collide and get de-duped by the zset)
-- ARGV[5] = ttl_seconds
--
-- Returns: { allowed(1/0), count_in_window(int), retry_after_ms }
--
-- Atomicity matters here for the same reason as token bucket: ZREMRANGEBYSCORE
-- + ZCARD + conditional ZADD has to happen as one indivisible step, otherwise
-- two concurrent requests can both see count < limit and both get admitted,
-- pushing the true count over the configured limit.

local key = KEYS[1]
local now_ms = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local member = ARGV[4]
local ttl_seconds = tonumber(ARGV[5])

local window_start = now_ms - window_ms

-- Drop everything that has fallen out of the trailing window.
redis.call('ZREMRANGEBYSCORE', key, '-inf', window_start)

local count = redis.call('ZCARD', key)

local allowed = 0
local retry_after_ms = 0

if count < limit then
  redis.call('ZADD', key, now_ms, member)
  allowed = 1
  count = count + 1
else
  -- retry_after: when will the oldest entry in the window expire out?
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  if oldest and oldest[2] then
    local oldest_ts = tonumber(oldest[2])
    retry_after_ms = math.max(0, (oldest_ts + window_ms) - now_ms)
  else
    retry_after_ms = window_ms
  end
end

redis.call('EXPIRE', key, ttl_seconds)

return { allowed, count, retry_after_ms }
