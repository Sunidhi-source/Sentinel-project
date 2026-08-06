-- Sliding Window Counter rate limiter (atomic, single round-trip)
--
-- The production-pragmatic middle ground between Token Bucket and Sliding
-- Window Log: O(1) memory like a fixed-window counter (two integers instead
-- of a log of every request), but approximates a true sliding window by
-- taking a weighted blend of the previous fixed window's count and the
-- current one, based on how far we are into the current window.
--
--   estimated_count = current_window_count
--                    + previous_window_count * (1 - elapsed_fraction_of_current_window)
--
-- This is an approximation (assumes uniform request distribution within the
-- previous window), not exact like the log approach -- that's the tradeoff
-- for O(1) memory.
--
-- KEYS[1] = current window counter key,  e.g. "sentinel:{route}:{scopeKey}:swc:{windowIndex}"
-- KEYS[2] = previous window counter key, e.g. "sentinel:{route}:{scopeKey}:swc:{windowIndex-1}"
--
-- ARGV[1] = now_ms
-- ARGV[2] = window_ms
-- ARGV[3] = limit
-- ARGV[4] = ttl_seconds
--
-- Returns: { allowed(1/0), estimated_count(float*1000 as int for precision), retry_after_ms }

local curr_key = KEYS[1]
local prev_key = KEYS[2]

local now_ms = tonumber(ARGV[1])
local window_ms = tonumber(ARGV[2])
local limit = tonumber(ARGV[3])
local ttl_seconds = tonumber(ARGV[4])

local elapsed_in_current = now_ms % window_ms
local fraction_elapsed = elapsed_in_current / window_ms

local curr_count = tonumber(redis.call('GET', curr_key)) or 0
local prev_count = tonumber(redis.call('GET', prev_key)) or 0

local estimated = curr_count + prev_count * (1 - fraction_elapsed)

local allowed = 0
local retry_after_ms = 0

if estimated < limit then
  curr_count = redis.call('INCR', curr_key)
  redis.call('EXPIRE', curr_key, ttl_seconds)
  allowed = 1
  estimated = estimated + 1
else
  -- rough estimate: time left in current window before the weighted count
  -- drops enough to admit another request
  retry_after_ms = window_ms - elapsed_in_current
end

return { allowed, math.floor(estimated * 1000), retry_after_ms }
