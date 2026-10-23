-- profiles/cng.lua — dpMaps CNG auto-rickshaw profile (Stage 004 §5.2).
-- Self-contained (see car.lua header). 3-wheeler semantics: 45 km/h
-- mechanical clamp, slower U-turns, primary/trunk capped at 35 km/h.
-- Expressway / flyover / VIP-hour bans are [UNVERIFIED] — curated lists,
-- default-off until verified (time-dependent rules live in the §6.5
-- per-bucket weight multipliers, never in static Lua).

local MAX_SPEED_KMH = 45 -- [ESTIMATE — verify with fleet specs]
local PRIMARY_CAP_KMH = 35 -- [ESTIMATE] within the 45 km/h clamp
local DEFAULT_SPEED_KMH = 20 -- [ESTIMATE]
local U_TURN_PENALTY_S = 35 -- [ESTIMATE] 3-wheelers turn slowly
local BANNED_WAYS_FILE = 'restricted_ways_cng.txt'

local banned_ways = {}
do
  local f = io.open(BANNED_WAYS_FILE, 'r')
  if f then
    for line in f:lines() do
      local id = line:match('^%s*(%d+)%s*$')
      if id then banned_ways[id] = true end
    end
    f:close()
  end
end

function setup()
  return {
    properties = {
      max_speed_for_map_matching = MAX_SPEED_KMH / 3.6, -- 45 km/h top speed
      weight_name = 'duration',
      process_call_tagless_node = false,
      u_turn_penalty = U_TURN_PENALTY_S,
      continue_straight_at_waypoint = false,
      use_turn_restrictions = true,
      left_hand_driving = true -- Bangladesh drives on the left
    },
    default_mode = mode.driving,
    default_speed = DEFAULT_SPEED_KMH,
    banned_ways_file = BANNED_WAYS_FILE
  }
end

function process_way(profile, way, result, relations)
  local highway = way:get_value_by_key('highway')
  local motor_vehicle = way:get_value_by_key('motor_vehicle')
  local access = way:get_value_by_key('access')

  -- Tag-first exclusion; curated way-ID blocklist (verified restrictions only).
  if motor_vehicle == 'no' or access == 'no' then
    return
  end
  if highway == 'footway' or highway == 'cycleway'
      or highway == 'path' or highway == 'steps'
      or highway == 'motorway' then
    -- motorway exclusion is the mechanical default for 3-wheelers; named
    -- expressway/flyover bans beyond this stay in the default-off curated list.
    return
  end

  if banned_ways[tostring(way:id())] then
    return
  end

  -- Cap maximum speed on primary/trunk roads.
  if highway == 'primary' or highway == 'trunk' then
    result.forward_speed = PRIMARY_CAP_KMH
    result.backward_speed = PRIMARY_CAP_KMH
    result.forward_mode = mode.driving
    result.backward_mode = mode.driving
    return
  end

  -- Default: routable within the mechanical clamp.
  result.forward_mode = mode.driving
  result.backward_mode = mode.driving
end

function process_node(profile, node, result)
  local access = node:get_value_by_key('access')
  local motor_vehicle = node:get_value_by_key('motor_vehicle')
  local barrier = node:get_value_by_key('barrier')
  if access == 'no' or motor_vehicle == 'no' then
    result.barrier = true
  elseif barrier == 'gate' or barrier == 'bollard' then
    result.barrier = true
  end
end

function process_turn(profile, turn)
  if turn.is_u_turn then
    turn.duration = U_TURN_PENALTY_S
  end
end

return {
  MAX_SPEED_KMH = MAX_SPEED_KMH,
  PRIMARY_CAP_KMH = PRIMARY_CAP_KMH,
  U_TURN_PENALTY_S = U_TURN_PENALTY_S,
  BANNED_WAYS_FILE = BANNED_WAYS_FILE
}
