-- profiles/bike.lua — dpMaps motorbike profile (Stage 004 §5.1).
-- Self-contained (see car.lua header). F-004-8: motorbikes are motor
-- vehicles — unified mode.driving throughout. Narrow informal alleys down
-- to 1.2 m stay routable so Old Dhaka settlements don't disconnect.

local MIN_ALLEY_WIDTH_M = 1.2 -- [ESTIMATE] 2-wheeler minimum alley width
local DEFAULT_SPEED_KMH = 25 -- [ESTIMATE] average urban speed
local ALLEY_SPEED_KMH = 22 -- [ESTIMATE] residential/service alley speed
local U_TURN_PENALTY_S = 15 -- [ESTIMATE] bikes turn easily
local BANNED_WAYS_FILE = 'restricted_ways_bike.txt'

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
      max_speed_for_map_matching = 80 / 3.6, -- 80 km/h [ESTIMATE]
      weight_name = 'duration',
      process_call_tagless_node = false,
      u_turn_penalty = U_TURN_PENALTY_S,
      continue_straight_at_waypoint = false,
      use_turn_restrictions = true,
      left_hand_driving = true -- Bangladesh drives on the left
    },
    -- Motorbikes are motor vehicles: driving mode throughout (F-004-8).
    default_mode = mode.driving,
    default_speed = DEFAULT_SPEED_KMH,
    -- Narrow alleys accessible to 2-wheelers.
    traffic_alley_min_width = MIN_ALLEY_WIDTH_M,
    -- Curated restriction set, populated ONLY from verified regulation.
    banned_ways_file = BANNED_WAYS_FILE
  }
end

function process_way(profile, way, result, relations)
  local data = {
    highway = way:get_value_by_key('highway'),
    access = way:get_value_by_key('access'),
    motorcycle = way:get_value_by_key('motorcycle'),
    motor_vehicle = way:get_value_by_key('motor_vehicle'),
    motorroad = way:get_value_by_key('motorroad'),
    width = way:get_value_by_key('width')
  }

  -- Tag-first exclusion; curated way-ID blocklist applied by the loader.
  -- NOTE: motorroad=yes (expressway) bars 2-wheelers pending verification of
  -- the expressway 2-wheeler rule [UNVERIFIED — default-off list governs].
  if data.access == 'no' or data.motorcycle == 'no'
      or data.motor_vehicle == 'no' then
    return
  end
  if data.highway == 'footway' or data.highway == 'cycleway'
      or data.highway == 'path' or data.highway == 'steps' then
    return
  end

  if banned_ways[tostring(way:id())] then
    return
  end

  local w = tonumber(data.width)
  if w and w < MIN_ALLEY_WIDTH_M then
    return
  end

  -- Permit residential, living_street, service, and unclassified alleys.
  if data.highway == 'residential' or data.highway == 'living_street'
      or data.highway == 'service' or data.highway == 'unclassified' then
    result.forward_mode = mode.driving
    result.backward_mode = mode.driving
    result.forward_speed = ALLEY_SPEED_KMH
    result.backward_speed = ALLEY_SPEED_KMH
    return
  end

  -- Default: routable with driving mode; speeds from profile defaults.
  result.forward_mode = mode.driving
  result.backward_mode = mode.driving
end

function process_node(profile, node, result)
  local access = node:get_value_by_key('access')
  local motorcycle = node:get_value_by_key('motorcycle')
  local barrier = node:get_value_by_key('barrier')
  if access == 'no' or motorcycle == 'no' then
    result.barrier = true
  elseif barrier == 'gate' or barrier == 'bollard' then
    -- Bikes can pass lifting barriers; fixed bollards block.
    if barrier == 'bollard' then result.barrier = true end
  end
end

function process_turn(profile, turn)
  if turn.is_u_turn then
    turn.duration = U_TURN_PENALTY_S
  end
end

return {
  MIN_ALLEY_WIDTH_M = MIN_ALLEY_WIDTH_M,
  DEFAULT_SPEED_KMH = DEFAULT_SPEED_KMH,
  U_TURN_PENALTY_S = U_TURN_PENALTY_S,
  BANNED_WAYS_FILE = BANNED_WAYS_FILE
}
