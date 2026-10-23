-- profiles/car.lua — dpMaps car profile (Stage 004 §5.3).
-- Self-contained: only OSRM profile globals (setup/process_way/process_node/
-- process_turn). No external lib/ requires, so it loads from any mount path.
--
-- Encoding rules (plan §5): tag-first access; curated way-ID blocklist
-- (restricted_ways_car.txt, reviewed restrictions only); every [UNVERIFIED]
-- regulation list is default-off and enabled only after written verification.

local MIN_ALLEY_WIDTH_M = 2.5 -- [ESTIMATE] alleys narrower than this are barred
local EXPRESSWAY_MIN_KMH = 60 -- [ESTIMATE] elevated expressway weight floor
local EXPRESSWAY_MAX_KMH = 80 -- [ESTIMATE] elevated expressway weight ceiling
local BANNED_WAYS_FILE = 'restricted_ways_car.txt'

-- Curated blocklist, populated ONLY from verified regulation (default: empty).
-- The extractor container bind-mounts the profiles dir; entries are OSM way IDs.
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
      max_speed_for_map_matching = 120 / 3.6,
      weight_name = 'duration',
      process_call_tagless_node = false,
      u_turn_penalty = 20,
      continue_straight_at_waypoint = false,
      use_turn_restrictions = true,
      left_hand_driving = true -- Bangladesh drives on the left
    },
    default_mode = mode.driving,
    default_speed = 35, -- [ESTIMATE] urban default km/h
    banned_ways_file = BANNED_WAYS_FILE
  }
end

function process_way(profile, way, result, relations)
  local data = {
    highway = way:get_value_by_key('highway'),
    access = way:get_value_by_key('access'),
    motor_vehicle = way:get_value_by_key('motor_vehicle'),
    oneway = way:get_value_by_key('oneway'),
    width = way:get_value_by_key('width'),
    motorroad = way:get_value_by_key('motorroad'),
    link = way:get_value_by_key('highway')
  }

  -- Tag-first exclusion (never name matching).
  if data.access == 'no' or data.motor_vehicle == 'no' then
    return
  end
  if data.highway == 'footway' or data.highway == 'cycleway'
      or data.highway == 'path' or data.highway == 'steps' then
    return
  end

  -- Curated way-ID blocklist (verified restrictions only).
  if banned_ways[tostring(way:id())] then
    return
  end

  -- Alley width filter: cars need >= 2.5 m.
  local w = tonumber(data.width)
  if w and w < MIN_ALLEY_WIDTH_M then
    return
  end

  -- Elevated expressway links get higher speed weights (access-verified only).
  if data.highway == 'motorway' or data.highway == 'trunk' then
    result.forward_speed = EXPRESSWAY_MIN_KMH
    result.backward_speed = EXPRESSWAY_MIN_KMH
    result.forward_mode = mode.driving
    result.backward_mode = mode.driving
    return
  end

  -- Default: routable by car with OSRM default speeds.
  result.forward_mode = mode.driving
  result.backward_mode = mode.driving
end

function process_node(profile, node, result)
  -- Tag-first node barriers.
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
  -- One-way and turn-restriction enforcement is OSRM-default; commercial-core
  -- compliance (Motijheel, Old Dhaka, Banani, Dhanmondi) verified via the
  -- Stage 004 §7 connectivity audit, not static lists here.
  if turn.is_u_turn then
    turn.duration = (profile.properties.u_turn_penalty or 20)
  end
end

return {
  MIN_ALLEY_WIDTH_M = MIN_ALLEY_WIDTH_M,
  EXPRESSWAY_MIN_KMH = EXPRESSWAY_MIN_KMH,
  EXPRESSWAY_MAX_KMH = EXPRESSWAY_MAX_KMH,
  BANNED_WAYS_FILE = BANNED_WAYS_FILE
}
