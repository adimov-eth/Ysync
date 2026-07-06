// Every tunable lives here (spec §18, Appendix A).

// Clock sync
export const PING_HZ = 1
export const WARMUP_PINGS = 8
export const WARMUP_HZ = 4
export const WINDOW = 32
export const RTT_GATE_MS = 2
export const CLOCK_UNC_MAX_MS = 5 // summed MAD above ⇒ clock_degraded (never widened, R4)
export const STALE_GAP_MS = 3_000
export const STALE_RTT_FACTOR = 5
export const STALE_JUMP_MS = 10
export const STALE_JUMP_COUNT = 5

// Sampler
export const JITTER_BUDGET_MS = 5
export const POLL_HZ = 50
export const EDGE_WINDOW = 16
export const RVFC_STALL_MS = 500

// Beacons
export const BEACON_HZ = 3
export const BEACON_MAX_AGE_S = 5
export const EXTRAP_CAP_S = 2

// Servo
export const DEADBAND_S = 0.010
export const TAU_S = 2.0
export const MAX_TRIM = 0.02
export const SLEW_PER_S = 0.02
export const HARD_SYNC_S = 0.40
export const SETTLE_MS = 250
export const SEEK_LEAD_INIT_S = 0.15
export const MICRO_SEEK_S = 0.025
export const COARSE_PERIOD_MS = 5_000
export const SERVO_TICK_MS = 250 // interval backstop; timeupdate also schedules ticks

// Rate probe & watchdog
export const PROBE_RATES = [1.02, 1.01, 1.005] as const
export const PROBE_DURATION_MS = 2_000
export const PROBE_TOLERANCE = 0.005
export const WATCHDOG_FIT_S = 3
export const WATCHDOG_EXTERNAL_MAX = 3 // external ratechanges per window before downgrade
export const WATCHDOG_EXTERNAL_WINDOW_MS = 30_000
export const WATCHDOG_MIN_TRIM = 0.005 // below this, downgrade to coarse

// Connection lifecycle
export const GRACE_S = 10
export const RESTART_AFTER_S = 5
export const RESTART_TIMEOUT_S = 10
export const PAIRING_TIMEOUT_MS = 20_000

// Ports
export const PORT_BACKOFF_MIN_MS = 250
export const PORT_BACKOFF_MAX_MS = 4_000

// Blobs
export const BLOB_TTL_S = 600
export const BLOB_MAX_ENC = 6_000
export const BLOB_MAX_JSON = 20_480
export const BLOB_MAX_SDP = 16_384
export const NAME_MAX_CHARS = 24

// Network
export const STUN_URL = "stun:stun.l.google.com:19302"
export const MAX_PEERS = 7

// Rate limiting (spec §14)
export const INBOUND_MSG_PER_S_MAX = 50
export const WIRE_MSG_MAX_CHARS = 8_192

// UI
export const OFFSET_SLIDER_MAX_MS = 500

export const PROTO_VERSION = 1
