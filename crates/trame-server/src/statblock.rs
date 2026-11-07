//! ============================================================================
//! MONSTER STAT BLOCK COPY, BOUNDS & TOKEN DERIVATION (statblock.rs)
//! ============================================================================
//!
//! PURPOSE:
//! --------
//! Staged and spawned `SyntheticToken`s carry a copy of their dnd5e
//! `MonsterStatBlock` (`TokenState::stat_block`, D7). Without this module a
//! compendium monster reached the table as a 20 HP / AC 10 placeholder (UA2),
//! and whatever HP, AC, speed or senses a client put on a spawned token were
//! trusted verbatim. Here the server resolves the stat block source, checks
//! its bounds, and derives every combat number on the token from it.
//!
//! INVARIANTS & SAFETY BOUNDARIES:
//! -------------------------------
//!   1. `Server-Side Sources Only`:
//!      - A string `stat_block` is a reference: `srd:monster:<slug>` resolves
//!        against the SRD 5.2.1 pack compiled into the binary
//!        (`packages/game-systems/dnd5e/packs/monsters.json`); actor template
//!        UUIDs are resolved by `campaigns::resolve_spawn` before the room sees
//!        the command. An object is a homebrew or client copy and is validated.
//!   2. `Explicit Bounds (D7, MONSTER_STAT_BLOCK_BOUNDS)`:
//!      - At most `MAX_STAT_BLOCK_BYTES` of JSON; AC `1..=30`, HP `1..=1000`,
//!        speeds `0..=200` ft, senses `0..=500` ft, passive Perception `1..=40`,
//!        ability scores `1..=30`, initiative `-10..=20`, melee reach
//!        `0..=100` ft, `<= 20` actions per list, damage types and condition
//!        ids from the SRD lists. A violation rejects the whole command.
//!   3. `Derived, Not Trusted`:
//!      - `hp`, `max_hp`, `ac`, speed, senses, reach (longest melee attack,
//!        else 5 ft), damage affinities, Dexterity modifier, initiative bonus
//!        and footprint (from size) are overwritten from the stat block, so a
//!        client value never survives. The token name stays (GMs number them).
//!   4. `Every Path Normalizes`:
//!      - `normalize_command` runs in the room for direct commands, batches,
//!        staged MCP proposals and the staged tokens of `ActivateScene`, so
//!        WebSocket, MCP and REST spawns share one rule and the WAL stores
//!        the normalized command (replay never needs the pack).
//!
//! EXECUTION LIFECYCLE:
//! --------------------
//!   `normalize_command(cmd)`
//!     ├── 1. Collect the tokens a `SpawnToken` / `ActivateScene` introduces.
//!     ├── 2. `resolve_stat_block`: SRD key -> pack copy, object -> as is.
//!     ├── 3. `validate_stat_block`: size cap, then every bounded field.
//!     └── 4. `apply_stat_block`: overwrite the token's combat numbers.
//! ============================================================================

use serde_json::Value;
use std::collections::HashMap;
use std::sync::OnceLock;
use trame_engine::commands::{TokenState, TrameCommand};

/// Upper bound on a serialized stat block (`bytes`). The largest SRD block is about 6 KiB.
pub const MAX_STAT_BLOCK_BYTES: usize = 32 * 1024;

/// Prefix of SRD monster references (`srd:monster:goblin`).
pub const SRD_MONSTER_PREFIX: &str = "srd:monster:";

/// Maximum entries in `actions`, `bonusActions`, `reactions` and `traits`.
const MAX_ACTIONS_PER_LIST: usize = 20;
/// Maximum legendary action options.
const MAX_LEGENDARY_OPTIONS: usize = 10;
/// Default melee reach in feet (`ft`) when no melee attack prints one.
const DEFAULT_REACH_FT: f64 = 5.0;

const SIZES: [(&str, u8); 6] = [
    ("tiny", 1),
    ("small", 1),
    ("medium", 1),
    ("large", 2),
    ("huge", 3),
    ("gargantuan", 4),
];
const ABILITIES: [&str; 6] = ["str", "dex", "con", "int", "wis", "cha"];
const SPEED_MODES: [&str; 5] = ["walk", "fly", "swim", "climb", "burrow"];
const SENSES: [&str; 4] = ["darkvision", "blindsight", "tremorsense", "truesight"];
/// SRD 5.2.1 damage type ids (lowercase).
pub const DAMAGE_TYPES: [&str; 13] = [
    "acid",
    "bludgeoning",
    "cold",
    "fire",
    "force",
    "lightning",
    "necrotic",
    "piercing",
    "poison",
    "psychic",
    "radiant",
    "slashing",
    "thunder",
];
const CONDITIONS: [&str; 15] = [
    "blinded",
    "charmed",
    "deafened",
    "exhaustion",
    "frightened",
    "grappled",
    "incapacitated",
    "invisible",
    "paralyzed",
    "petrified",
    "poisoned",
    "prone",
    "restrained",
    "stunned",
    "unconscious",
];

/// SRD 5.2.1 stat blocks keyed by pack id (`srd:monster:<slug>`), parsed once on first use.
fn srd_stat_blocks() -> &'static HashMap<String, Value> {
    static PACK: OnceLock<HashMap<String, Value>> = OnceLock::new();
    PACK.get_or_init(|| {
        let raw = include_str!("../../../packages/game-systems/dnd5e/packs/monsters.json");
        let entries: Vec<Value> = serde_json::from_str(raw).unwrap_or_default();
        entries
            .into_iter()
            .filter_map(|mut entry| {
                let id = entry.get("id")?.as_str()?.to_string();
                let block = entry.get_mut("data")?.get_mut("statBlock")?.take();
                block.is_object().then_some((id, block))
            })
            .collect()
    })
}

/// Copy of the SRD stat block for `key` (`srd:monster:<slug>`, or the bare slug).
pub fn srd_stat_block(key: &str) -> Option<Value> {
    let key = key.trim();
    let id = if key.starts_with(SRD_MONSTER_PREFIX) {
        key.to_string()
    } else {
        format!("{SRD_MONSTER_PREFIX}{key}")
    };
    srd_stat_blocks().get(&id).cloned()
}

/// Resolves a `stat_block` value to a validated stat block object: an SRD reference string
/// becomes the pack copy, an object is checked as is. Anything else is rejected.
pub fn resolve_stat_block(source: &Value) -> Result<Value, String> {
    let block = match source {
        Value::String(key) => srd_stat_block(key)
            .ok_or_else(|| format!("invalid stat block: unknown monster reference '{key}'"))?,
        Value::Object(_) => source.clone(),
        _ => return Err("invalid stat block: expected an object or an SRD reference".into()),
    };
    validate_stat_block(&block)?;
    Ok(block)
}

fn bounded_number(block: &Value, pointer: &str, min: f64, max: f64) -> Result<f64, String> {
    let n = block
        .pointer(pointer)
        .and_then(Value::as_f64)
        .ok_or_else(|| format!("invalid stat block: {pointer} is required"))?;
    optional_bounded(Some(n), pointer, min, max).map(|_| n)
}

fn optional_bounded(n: Option<f64>, pointer: &str, min: f64, max: f64) -> Result<(), String> {
    match n {
        Some(n) if !(min..=max).contains(&n) => Err(format!(
            "invalid stat block: {pointer} must be within {min}..={max}"
        )),
        _ => Ok(()),
    }
}

fn optional_number(block: &Value, pointer: &str, min: f64, max: f64) -> Result<(), String> {
    match block.pointer(pointer) {
        None | Some(Value::Null) => Ok(()),
        Some(v) => optional_bounded(
            Some(
                v.as_f64()
                    .ok_or_else(|| format!("invalid stat block: {pointer} must be a number"))?,
            ),
            pointer,
            min,
            max,
        ),
    }
}

fn id_list<'a>(block: &'a Value, key: &str, allowed: &[&str]) -> Result<Vec<&'a str>, String> {
    let Some(value) = block.get(key) else {
        return Ok(Vec::new());
    };
    let list = value
        .as_array()
        .ok_or_else(|| format!("invalid stat block: {key} must be a list"))?;
    list.iter()
        .map(|v| {
            v.as_str()
                .filter(|s| allowed.contains(s))
                .ok_or_else(|| format!("invalid stat block: {key} holds an unknown id"))
        })
        .collect()
}

fn action_list<'a>(block: &'a Value, pointer: &str, max_len: usize) -> Result<&'a [Value], String> {
    match block.pointer(pointer) {
        None => Ok(&[]),
        Some(Value::Array(list)) if list.len() <= max_len => Ok(list.as_slice()),
        Some(_) => Err(format!(
            "invalid stat block: {pointer} must be a list of at most {max_len} entries"
        )),
    }
}

/// Checks the size cap and every bounded field the server reads or that `MonsterStatBlock`
/// bounds (invariant 2). Unknown extra fields are tolerated; the client schema rejects them.
pub fn validate_stat_block(block: &Value) -> Result<(), String> {
    if !block.is_object() {
        return Err("invalid stat block: expected an object".into());
    }
    let bytes = serde_json::to_vec(block)
        .map(|b| b.len())
        .unwrap_or(usize::MAX);
    if bytes > MAX_STAT_BLOCK_BYTES {
        return Err(format!(
            "invalid stat block: larger than {MAX_STAT_BLOCK_BYTES} bytes"
        ));
    }
    let name_len = block
        .get("name")
        .and_then(Value::as_str)
        .map(|n| n.chars().count())
        .unwrap_or(0);
    if !(1..=120).contains(&name_len) {
        return Err("invalid stat block: name must be 1..=120 characters".into());
    }
    let size = block.get("size").and_then(Value::as_str).unwrap_or("");
    if !SIZES.iter().any(|(s, _)| *s == size) {
        return Err("invalid stat block: size is not an SRD size".into());
    }
    bounded_number(block, "/armorClass/value", 1.0, 30.0)?;
    bounded_number(block, "/hitPoints/average", 1.0, 1000.0)?;
    bounded_number(block, "/speed/walk", 0.0, 200.0)?;
    for mode in &SPEED_MODES[1..] {
        optional_number(block, &format!("/speed/{mode}"), 0.0, 200.0)?;
    }
    for ability in ABILITIES {
        bounded_number(block, &format!("/abilities/{ability}"), 1.0, 30.0)?;
        optional_number(block, &format!("/savingThrows/{ability}"), -10.0, 30.0)?;
    }
    optional_number(block, "/initiativeBonus", -10.0, 20.0)?;
    for sense in SENSES {
        optional_number(block, &format!("/senses/{sense}"), 0.0, 500.0)?;
    }
    optional_number(block, "/senses/passivePerception", 1.0, 40.0)?;
    for key in [
        "damageVulnerabilities",
        "damageResistances",
        "damageImmunities",
    ] {
        id_list(block, key, &DAMAGE_TYPES)?;
    }
    id_list(block, "conditionImmunities", &CONDITIONS)?;
    action_list(block, "/traits", MAX_ACTIONS_PER_LIST)?;
    for list in ["/actions", "/bonusActions", "/reactions"] {
        for action in action_list(block, list, MAX_ACTIONS_PER_LIST)? {
            optional_number(action, "/attack/reachFt", 0.0, 100.0)?;
            optional_number(action, "/attack/toHit", -5.0, 30.0)?;
        }
    }
    action_list(block, "/legendaryActions/options", MAX_LEGENDARY_OPTIONS)?;
    Ok(())
}

/// Longest melee reach among the stat block's attack actions (`ft`), else `DEFAULT_REACH_FT`.
fn melee_reach_ft(block: &Value) -> f64 {
    ["/actions", "/bonusActions", "/reactions"]
        .iter()
        .filter_map(|p| block.pointer(p).and_then(Value::as_array))
        .flatten()
        .filter_map(|a| a.get("attack"))
        .filter(|attack| {
            matches!(
                attack.get("kind").and_then(Value::as_str),
                Some("melee" | "melee_or_ranged")
            )
        })
        .filter_map(|attack| attack.get("reachFt").and_then(Value::as_f64))
        .fold(None, |best: Option<f64>, r| {
            Some(best.map_or(r, |b| b.max(r)))
        })
        .unwrap_or(DEFAULT_REACH_FT)
}

fn strings(block: &Value, key: &str) -> Vec<String> {
    block
        .get(key)
        .and_then(Value::as_array)
        .map(|l| {
            l.iter()
                .filter_map(Value::as_str)
                .map(str::to_string)
                .collect()
        })
        .unwrap_or_default()
}

/// Overwrites the token's combat numbers from an already validated `block` (invariant 3)
/// and stores the copy on `token.stat_block`.
pub fn apply_stat_block(token: &mut TokenState, block: Value) {
    let num = |p: &str| block.pointer(p).and_then(Value::as_f64);
    let hp = num("/hitPoints/average").unwrap_or(1.0).round() as i32;
    token.max_hp = hp.max(1);
    token.hp = token.max_hp;
    token.temp_hp = 0;
    token.ac = num("/armorClass/value").unwrap_or(10.0).round() as i32;
    let speed = num("/speed/walk").unwrap_or(0.0);
    token.speed_max_ft = speed;
    token.speed_remaining_ft = speed;
    token.senses.darkvision_range_ft = num("/senses/darkvision").unwrap_or(0.0);
    token.senses.blindsight_range_ft = num("/senses/blindsight").unwrap_or(0.0);
    token.senses.tremorsense_range_ft = num("/senses/tremorsense").unwrap_or(0.0);
    token.senses.truesight_range_ft = num("/senses/truesight").unwrap_or(0.0);
    token.reach_ft = melee_reach_ft(&block);
    token.damage_resistances = strings(&block, "damageResistances");
    token.damage_immunities = strings(&block, "damageImmunities");
    token.damage_vulnerabilities = strings(&block, "damageVulnerabilities");
    let dex = num("/abilities/dex").unwrap_or(10.0).round() as i32;
    token.dex_mod = (dex - 10).div_euclid(2);
    token.initiative_extra =
        num("/initiativeBonus").map_or(0, |b| b.round() as i32 - token.dex_mod);
    let size = block
        .get("size")
        .and_then(Value::as_str)
        .unwrap_or("medium");
    let cells = SIZES
        .iter()
        .find(|(s, _)| *s == size)
        .map_or(1, |(_, c)| *c);
    token.grid_w = cells;
    token.grid_h = cells;
    token.stat_block = Some(block);
}

/// Resolves, validates and applies `token.stat_block` when present; tokens without one pass
/// through unchanged.
pub fn normalize_token(token: &mut TokenState) -> Result<(), String> {
    let Some(source) = token.stat_block.take() else {
        return Ok(());
    };
    let block = resolve_stat_block(&source)?;
    apply_stat_block(token, block);
    Ok(())
}

/// Normalizes the stat blocks of the tokens `cmd` introduces (`SpawnToken`, the staged tokens
/// of a resolved `ActivateScene`); other commands pass through.
pub fn normalize_command(cmd: &mut TrameCommand) -> Result<(), String> {
    match cmd {
        TrameCommand::SpawnToken { token } => normalize_token(token),
        TrameCommand::ActivateScene {
            scene: Some(scene), ..
        } => scene.staged_tokens.iter_mut().try_for_each(normalize_token),
        _ => Ok(()),
    }
}
