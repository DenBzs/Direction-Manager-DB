// 🪄전개지시M 확장 - direction 플레이스홀더 관리 (컴팩트 UI 전용)
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid } from "../../../../script.js";
import { Popup } from "../../../popup.js";

const extensionName = "Direction-Manager-DB";
const LOG_PREFIX = "[🪄전개지시M]";

const DEFAULT_DIRECTION_PROMPT_CHAT = `<direction>
- Resume the story based on the director's instructions below.
- The director only provides drafts; refine them into natural prose instead of directly quoting the sentences.
- Creatively construct and fill in any parts lacking persuasive causality so that the narrative suggested by the director unfolds smoothly.

[Direction(If blank, develop the story as you see fit): {{direction}}]
</direction>`;

const DEFAULT_DIRECTION_PROMPT_GLOBAL = `<format_rules>
- These are standing formatting/style rules for every reply in this roleplay. Follow them exactly, without exception, for as long as they are enabled below.
- Do not quote or restate these rules in your reply; just apply them silently.

{{direction}}
</format_rules>`;

const DEFAULT_DIRECTION_PROMPT_CHAR = `<character_notes>
- The following are ongoing notes about the current situation, emotions, personality, or world details that apply to this conversation for the next several turns.
- Treat them as established fact and weave them naturally into the story; do not quote them directly or announce that you received notes.

{{direction}}
</character_notes>`;

// v4 이전 단일 프롬프트 시절의 기본값 (v5 마이그레이션 비교용)
const DEFAULT_DIRECTION_PROMPT = DEFAULT_DIRECTION_PROMPT_CHAT;

const DEFAULT_DIRECTION_PROMPTS = {
    global: DEFAULT_DIRECTION_PROMPT_GLOBAL,
    char: DEFAULT_DIRECTION_PROMPT_CHAR,
    chat: DEFAULT_DIRECTION_PROMPT_CHAT,
};

function defaultPlaceholderState() {
    return {
        enabled: false,
        entries: [""],
        activeIndex: 0,
        content: "",
    };
}

const SCOPE_LABELS = {
    global: "[Format Rules]",
    char: "[Character Notes]",
    chat: "[Director's Note]",
};

const SCOPE_ORDER = ["global", "char", "chat"];

// 기록에 남는 항목의 최대 개수(현재 보고 있는 칸 포함). 화면에는 N/5로 표시된다.
const HISTORY_TOTAL_MAX = 5;
const HISTORY_MIN_CHARS = 1;
// 구버전 데이터({content, history} 형태) 호환용
const HISTORY_MAX = HISTORY_TOTAL_MAX - 1;

function defaultScopeState() {
    return {
        direction: defaultPlaceholderState(),
    };
}

const defaultSettings = {
    global: defaultScopeState(),
    chars: {},
    chats: {},
    presets: {
        direction: { global: [], char: [], chat: [] },
    },
    extensionEnabled: true,
    directionPrompt: { ...DEFAULT_DIRECTION_PROMPTS },
    // 0: Chat History 끝에 삽입, >0: 끝에서 N번째 위치에 삽입
    promptDepth: { global: 1, char: 1, chat: 1 },
    lastScope: "chat",
    _migratedV2: false,
    _migratedV3: false,
    _migratedV4: false,
    _migratedV5: false,
};

let currentScope = "chat";
function textareaHeightGroup(scope) {
    return scope === "chat" ? "chat" : "shared";
}
let compactUITextareaHeights = { shared: "", chat: "" };
let chatHeightIsCustom = false;
let resizeCandidateHeight = null;
let cachedPresetRowHeight = 0;

function measurePresetRowHeight() {
    if (!compactUIPopup) return 0;

    const presetRow = compactUIPopup.find(".dm-compact--preset-row");

    if (!presetRow.length) return 0;

    const wasHidden = compactUIPopup.hasClass("dm-compact--hide-preset");

    if (wasHidden) {
        compactUIPopup.removeClass("dm-compact--hide-preset");
    }

    const height = presetRow.outerHeight(true) || 0;

    if (wasHidden) {
        compactUIPopup.addClass("dm-compact--hide-preset");
    }

    return height;
}

function defaultTextareaHeightPx() {
    return window.innerWidth <= 480 ? "130px" : "160px";
}

// 채팅 탭은 직접 리사이즈한 적이 없으면 (공용 높이 + 프리셋 줄 높이)로 맞춰 팝업 크기를 동일하게 유지
function restoreTextareaHeightForCurrentScope() {
    if (!compactUIPopup) return;

    const textarea = compactUIPopup.find(".dm-compact--textarea");

    if (!textarea.length) return;

    if (currentScope === "chat" && !chatHeightIsCustom) {
        const sharedPx = parseFloat(compactUITextareaHeights.shared || defaultTextareaHeightPx())
            || parseFloat(defaultTextareaHeightPx());
        textarea[0].style.height = `${Math.round(sharedPx + cachedPresetRowHeight)}px`;
        return;
    }

    const group = textareaHeightGroup(currentScope);
    textarea[0].style.height = compactUITextareaHeights[group] || defaultTextareaHeightPx();
}

// 팝업을 열 때 한 번만 계산. 키보드 상태와 무관하게 screen.availHeight 기준.
function applyTextareaHeightCap() {
    if (!compactUIPopup) return;

    const textarea = compactUIPopup.find(".dm-compact--textarea");

    if (!textarea.length) return;

    const header = compactUIPopup.find(".dm-compact--header");
    const scopeRow = compactUIPopup.find(".dm-compact--scope-row");

    const chromeHeight =
        (header.outerHeight(true) || 0) +
        (scopeRow.outerHeight(true) || 0) +
        cachedPresetRowHeight +
        16;

    const viewportBasis = (window.screen && window.screen.availHeight) || window.innerHeight;
    const viewportBudget = viewportBasis * (window.innerWidth <= 480 ? 0.55 : 0.6);
    const maxTextareaHeight = Math.max(110, Math.round(viewportBudget - chromeHeight));

    textarea.css("max-height", `${maxTextareaHeight}px`);
}
// 타이핑 도중(팝업이 최신 칸을 보고 있을 때) "이번 세션을 시작하기 전 내용"을 기억해둔다.
// 팝업을 닫거나 범위를 바꿀 때, 이 스냅샷을 현재 칸 "바로 앞"에 끼워 넣어 새 기록으로 확정한다.
// entries의 순서 자체는 절대 바뀌지 않는다 — 탐색은 activeIndex만 움직인다.
let sessionSnapshot = null;

function isMeaningfulHistoryText(text) {
    return typeof text === "string" && text.replace(/\s/g, "").length >= HISTORY_MIN_CHARS;
}

function capEntries(entries) {
    if (entries.length > HISTORY_TOTAL_MAX) {
        entries.splice(0, entries.length - HISTORY_TOTAL_MAX);
    }
    return entries;
}

// 팝업을 열거나(스코프 전환 포함) ←/→로 위치를 옮긴 직후 호출: 지금 위치를 새 세션의 기준점으로 삼는다.
function beginHistorySession(scopedValue) {
    const lastIndex = scopedValue.entries.length - 1;
    sessionSnapshot = scopedValue.activeIndex === lastIndex ? scopedValue.entries[lastIndex] : null;
}

// 팝업 닫기 / 범위 전환 직전: 세션 시작 시점 내용이 지금과 다르면 새 기록 한 칸으로 확정한다.
function flushHistorySession() {
    if (sessionSnapshot === null) return;

    if (!compactUIPopup) {
        sessionSnapshot = null;
        return;
    }

    const placeholder = getPopupCurrentPlaceholder();
    const scopedValue = getCurrentScopeState(placeholder.key);
    const lastIndex = scopedValue.entries.length - 1;

    if (scopedValue.activeIndex === lastIndex) {
        const currentText = scopedValue.entries[lastIndex];

        if (currentText !== sessionSnapshot && isMeaningfulHistoryText(sessionSnapshot)) {
            scopedValue.entries.splice(lastIndex, 0, sessionSnapshot);
            capEntries(scopedValue.entries);
            scopedValue.activeIndex = scopedValue.entries.length - 1;
            scopedValue.content = scopedValue.entries[scopedValue.activeIndex];

            if (setCurrentScopeState(placeholder.key, scopedValue)) {
                saveSettingsDebounced();
            }
        }
    }

    sessionSnapshot = null;
}

// ←/→: 목록 순서는 그대로 두고 보고 있는 위치(activeIndex)만 옮긴다. 이 위치는 저장되어
// 팝업을 닫았다 다시 열어도 유지된다.
function navigateHistory(direction) {
    if (!compactUIPopup) return;

    const placeholder = getPopupCurrentPlaceholder();
    const scopedValue = getCurrentScopeState(placeholder.key);
    const target = scopedValue.activeIndex + direction;

    if (target < 0 || target >= scopedValue.entries.length) return;

    scopedValue.activeIndex = target;
    scopedValue.content = scopedValue.entries[target];

    if (!setCurrentScopeState(placeholder.key, scopedValue)) {
        console.warn(`${LOG_PREFIX} 현재 범위에 값을 저장하지 못했습니다.`);
        return;
    }

    compactUIPopup.find(".dm-compact--textarea").val(scopedValue.content);
    beginHistorySession(scopedValue);
    applyPlaceholderToSystem(placeholder);
    saveSettingsDebounced();
    updateAppliedIndicator();
}
// ST 네이티브 Popup이 떠 있는 동안 true (바깥 클릭으로 컴팩트 UI가 닫히지 않게 함)
let isNativePopupOpen = false;
let compactUIApplyDebounceTimer = null;
let promptEditorScope = "global";

const placeholders = [
    { key: "direction", name: "🪄전개지시M", isCustom: true },
];

let compactUIButton = null;
let compactUIPopup = null;

function cloneSettings(obj) {
    return JSON.parse(JSON.stringify(obj));
}

function getSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    return extension_settings[extensionName];
}

function sanitizePlaceholderValue(value) {
    let entries;

    if (Array.isArray(value?.entries) && value.entries.length) {
        entries = value.entries.filter((item) => typeof item === "string");
    } else {
        // 구버전({content, history} 또는 {content, previousContent}) 호환:
        // 예전 history는 "현재 내용 제외, 오래된 것 → 최신" 순서였으므로 그대로 앞에 붙이고
        // content를 맨 뒤(최신)에 둔다.
        let oldHistory = [];

        if (Array.isArray(value?.history)) {
            oldHistory = value.history.filter((item) => typeof item === "string" && item).slice(-HISTORY_MAX);
        } else if (typeof value?.previousContent === "string" && value.previousContent) {
            oldHistory = [value.previousContent];
        }

        entries = [...oldHistory, typeof value?.content === "string" ? value.content : ""];
    }

    if (!entries.length) entries = [""];
    capEntries(entries);

    let activeIndex = Number.isInteger(value?.activeIndex) ? value.activeIndex : entries.length - 1;
    activeIndex = Math.min(Math.max(activeIndex, 0), entries.length - 1);

    return {
        enabled: Boolean(value?.enabled),
        entries,
        activeIndex,
        content: entries[activeIndex],
    };
}

function sanitizeScopeState(scopeState) {
    const source = scopeState || {};
    return {
        direction: sanitizePlaceholderValue(source.direction),
    };
}

function sanitizePresetList(arr) {
    return Array.isArray(arr)
        ? arr
            .filter(item => item && typeof item.content === "string")
            .map(item => ({
                id: typeof item.id === "string" && item.id ? item.id : `${Date.now()}-${Math.random()}`,
                name: typeof item.name === "string" && item.name.trim() ? item.name.trim() : "이름 없는 프리셋",
                content: item.content,
            }))
        : [];
}

function sanitizeScopePresets(scopePresets) {
    const src = scopePresets || {};

    return {
        global: sanitizePresetList(src.global),
        char: sanitizePresetList(src.char),
        chat: sanitizePresetList(src.chat),
    };
}

function sanitizePresets(presets) {
    const src = presets || {};

    return {
        direction: sanitizeScopePresets(src.direction),
    };
}

function pruneRemovedPlaceholders() {
    const settings = getSettings();
    let changed = false;

    const dropLegacyKeys = (obj) => {
        if (!obj || typeof obj !== "object") return;

        ["char", "user"].forEach((key) => {
            if (key in obj) {
                delete obj[key];
                changed = true;
            }
        });
    };

    dropLegacyKeys(settings.global);
    Object.values(settings.chars || {}).forEach(dropLegacyKeys);
    Object.values(settings.chats || {}).forEach(dropLegacyKeys);
    dropLegacyKeys(settings.presets);
    dropLegacyKeys(settings);

    return changed;
}

function normalizePromptDepth(raw) {
    if (Number.isInteger(raw)) {
        return { global: raw, char: raw, chat: raw };
    }

    const src = raw && typeof raw === "object" ? raw : {};

    return {
        global: Number.isInteger(src.global) ? src.global : 1,
        char: Number.isInteger(src.char) ? src.char : 1,
        chat: Number.isInteger(src.chat) ? src.chat : 1,
    };
}

function getScopeDepth(scope) {
    const depth = getSettings().promptDepth;
    return Number.isInteger(depth?.[scope]) ? depth[scope] : 1;
}

function normalizeDirectionPromptObject(raw) {
    const src = raw && typeof raw === "object" ? raw : {};

    return {
        global: typeof src.global === "string" ? src.global : DEFAULT_DIRECTION_PROMPTS.global,
        char: typeof src.char === "string" ? src.char : DEFAULT_DIRECTION_PROMPTS.char,
        chat: typeof src.chat === "string" ? src.chat : DEFAULT_DIRECTION_PROMPTS.chat,
    };
}

function isGroupContext(context) {
    return Boolean(context?.groupId ?? context?.selected_group ?? context?.group?.id ?? context?.is_group);
}

function getCharAvatarKey() {
    const context = getContext();

    if (isGroupContext(context)) {
        return null;
    }

    if (this_chid != null && Array.isArray(characters) && characters[this_chid]) {
        return characters[this_chid].avatar || null;
    }

    return null;
}

function getCurrentCharKey() {
    return getCurrentChatKey();
}

function getCurrentChatName(context) {
    if (!context) return null;

    const candidates = [
        context.chatId,
        context.chatFileName,
        context.chatName,
        context.chat_id,
        context.chat_file,
        context.chat_file_name,
        context.chatMetadata?.file_name,
        context.metadata?.chat_file,
    ];

    for (const candidate of candidates) {
        if (candidate !== undefined && candidate !== null && String(candidate).trim() !== "") {
            return String(candidate);
        }
    }

    return null;
}

function getCurrentChatKey() {
    const context = getContext();
    const chatName = getCurrentChatName(context);

    if (!chatName) {
        return null;
    }

    const groupId = context?.groupId ?? context?.selected_group ?? context?.group?.id;

    if (groupId != null) {
        return `group::${groupId}::${chatName}`;
    }

    const charKey = getCharAvatarKey();

    if (!charKey) {
        return null;
    }

    return `${charKey}::${chatName}`;
}

function getScopeAvailability(scope) {
    if (scope === "global") {
        return { available: true, reason: "" };
    }

    if (!getCurrentChatKey()) {
        return { available: false, reason: "현재 채팅을 찾을 수 없습니다" };
    }

    return { available: true, reason: "" };
}

function normalizeSettings() {
    const settings = getSettings();

    settings.global = sanitizeScopeState(settings.global);
    settings.chars = settings.chars && typeof settings.chars === "object" ? settings.chars : {};
    settings.chats = settings.chats && typeof settings.chats === "object" ? settings.chats : {};
    settings.presets = sanitizePresets(settings.presets);
    settings.extensionEnabled = typeof settings.extensionEnabled === "boolean" ? settings.extensionEnabled : defaultSettings.extensionEnabled;
    settings.directionPrompt = normalizeDirectionPromptObject(settings.directionPrompt);
    settings.promptDepth = normalizePromptDepth(settings.promptDepth);
    settings.lastScope = SCOPE_ORDER.includes(settings.lastScope) ? settings.lastScope : "chat";
    settings._migratedV2 = Boolean(settings._migratedV2);
    settings._migratedV3 = Boolean(settings._migratedV3);
    settings._migratedV4 = Boolean(settings._migratedV4);
    settings._migratedV5 = Boolean(settings._migratedV5);

    Object.keys(settings.chars).forEach((key) => {
        settings.chars[key] = sanitizeScopeState(settings.chars[key]);
    });

    Object.keys(settings.chats).forEach((key) => {
        settings.chats[key] = sanitizeScopeState(settings.chats[key]);
    });
}

function migrateV1SettingsIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV2) {
        return false;
    }

    const hasLegacy = ["direction", "char", "user"].some((key) => settings[key] !== undefined);

    if (!hasLegacy) {
        settings._migratedV2 = true;
        return true;
    }

    settings.global = sanitizeScopeState(settings.global);

    if (settings.direction !== undefined) {
        settings.global.direction = sanitizePlaceholderValue(settings.direction);
        delete settings.direction;
    }

    delete settings.char;
    delete settings.user;

    settings._migratedV2 = true;
    console.log(`${LOG_PREFIX} v1 설정을 v2 global 스코프로 마이그레이션했습니다. {{char}}/{{user}} 값은 제거했습니다.`);
    return true;
}

// v2까지 프리셋은 범위 구분 없이 하나 → 세 범위 모두에 복사
function migrateV3PresetsIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV3) {
        return false;
    }

    const legacyList = Array.isArray(settings.presets?.direction) ? settings.presets.direction : null;

    if (legacyList && legacyList.length > 0) {
        const cloneWithNewIds = () => legacyList.map((item) => ({
            id: `${Date.now()}-${Math.random()}`,
            name: typeof item?.name === "string" && item.name.trim() ? item.name.trim() : "이름 없는 프리셋",
            content: typeof item?.content === "string" ? item.content : "",
        }));

        settings.presets = {
            direction: {
                global: cloneWithNewIds(),
                char: cloneWithNewIds(),
                chat: cloneWithNewIds(),
            },
        };

        console.log(`${LOG_PREFIX} 기존 프리셋 ${legacyList.length}개를 전역/캐릭터/채팅 범위 각각에 복사했습니다.`);
    }

    settings._migratedV3 = true;
    return true;
}

// v3까지 캐릭터 범위는 캐릭터 카드 단위로 저장됨 → v4부터 채팅 단위. 옮길 방법이 없어 예전 데이터 정리
function migrateV4LegacyCharScopeIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV4) {
        return false;
    }

    let removed = 0;

    Object.keys(settings.chars || {}).forEach((key) => {
        if (!key.includes("::")) {
            delete settings.chars[key];
            removed += 1;
        }
    });

    settings._migratedV4 = true;

    if (removed > 0) {
        console.log(`${LOG_PREFIX} 캐릭터 범위가 채팅 단위로 바뀌면서, 캐릭터 전체 공용으로 저장돼 있던 예전 데이터 ${removed}개를 정리했습니다.`);
    }

    return true;
}

// v4까지 프롬프트는 문자열 하나 → 범위별 객체로 변경. 커스텀했던 값은 "채팅" 범위로 이전
function migrateV5DirectionPromptIfNeeded() {
    const settings = getSettings();

    if (settings._migratedV5) {
        return false;
    }

    if (typeof settings.directionPrompt === "string") {
        const legacy = settings.directionPrompt;
        settings.directionPrompt = { ...DEFAULT_DIRECTION_PROMPTS };

        if (legacy && legacy.trim() !== "" && legacy !== DEFAULT_DIRECTION_PROMPT) {
            settings.directionPrompt.chat = legacy;
        }

        console.log(`${LOG_PREFIX} Direction 프롬프트가 범위별 템플릿으로 나뉘었습니다. 기존 프롬프트는 "채팅" 범위로 옮겼습니다.`);
    }

    settings._migratedV5 = true;
    return true;
}

async function loadSettings() {
    const settings = getSettings();

    if (Object.keys(settings).length === 0) {
        Object.assign(settings, cloneSettings(defaultSettings));
    }

    const migrated = migrateV1SettingsIfNeeded();
    const migratedV3 = migrateV3PresetsIfNeeded();
    const migratedV4 = migrateV4LegacyCharScopeIfNeeded();
    const migratedV5 = migrateV5DirectionPromptIfNeeded();
    const pruned = pruneRemovedPlaceholders();
    normalizeSettings();

    if (migrated || migratedV3 || migratedV4 || migratedV5 || pruned) {
        saveSettingsDebounced();
    }
}

function ensureScopedSettings(scope) {
    const settings = getSettings();

    if (scope === "global") {
        settings.global = sanitizeScopeState(settings.global);
        return settings.global;
    }

    if (scope === "char") {
        const key = getCurrentCharKey();
        if (!key) return null;
        settings.chars[key] = sanitizeScopeState(settings.chars[key]);
        return settings.chars[key];
    }

    const key = getCurrentChatKey();
    if (!key) return null;
    settings.chats[key] = sanitizeScopeState(settings.chats[key]);
    return settings.chats[key];
}

function getScopedSettings(scope) {
    const settings = getSettings();

    if (scope === "global") {
        return sanitizeScopeState(settings.global);
    }

    if (scope === "char") {
        const key = getCurrentCharKey();
        if (!key) return null;
        return sanitizeScopeState(settings.chars[key]);
    }

    const key = getCurrentChatKey();
    if (!key) return null;
    return sanitizeScopeState(settings.chats[key]);
}

function getScopedPlaceholder(scope, placeholderKey) {
    const scoped = getScopedSettings(scope);
    if (!scoped) return null;
    return sanitizePlaceholderValue(scoped[placeholderKey]);
}

function isValidEnabledContent(value) {
    return Boolean(value?.enabled && typeof value?.content === "string" && value.content.trim() !== "");
}

function resolveCombinedContent(placeholderKey) {
    const parts = [];
    const activeScopes = [];

    SCOPE_ORDER.forEach((scope) => {
        const value = getScopedPlaceholder(scope, placeholderKey);

        if (isValidEnabledContent(value)) {
            parts.push(`${SCOPE_LABELS[scope]}\n${value.content.trim()}`);
            activeScopes.push(scope);
        }
    });

    return {
        content: parts.join("\n\n"),
        activeScopes,
    };
}

function commitDirectionContentNow(placeholder) {
    clearTimeout(compactUIApplyDebounceTimer);
    compactUIApplyDebounceTimer = null;
    applyPlaceholderToSystem(placeholder);
    updateAppliedIndicator();
}

function applyPlaceholderToSystem(placeholder) {
    const combined = resolveCombinedContent(placeholder.key);

    if (combined.activeScopes.length === 0) {
        removePlaceholderFromSystem(placeholder.key);
        return;
    }

    registerCustomPlaceholder(placeholder.key, combined.content);
}

function registerCustomPlaceholder(key, content) {
    try {
        const context = getContext();

        if (context && context.registerMacro) {
            if (context.unregisterMacro) {
                context.unregisterMacro(key);
            }

            context.registerMacro(key, content || "", `🪄전개지시M: ${key}`);
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to register custom placeholder:`, error);
    }
}

function removePlaceholderFromSystem(key) {
    try {
        const context = getContext();

        if (context && context.unregisterMacro) {
            context.unregisterMacro(key);
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to remove placeholder from system:`, error);
    }
}

function applyAllPlaceholders() {
    placeholders.forEach((placeholder) => {
        applyPlaceholderToSystem(placeholder);
    });
}

function removeAllPlaceholders() {
    placeholders.forEach((placeholder) => {
        removePlaceholderFromSystem(placeholder.key);
    });
}

function getPopupCurrentPlaceholder() {
    return placeholders[0];
}

function getScopeButtonTitle(scope) {
    const availability = getScopeAvailability(scope);

    if (availability.available) {
        return "";
    }

    return availability.reason;
}

function getCurrentScopeState(placeholderKey) {
    const scoped = getScopedSettings(currentScope);

    if (!scoped) {
        return defaultPlaceholderState();
    }

    return sanitizePlaceholderValue(scoped[placeholderKey]);
}

function setCurrentScopeState(placeholderKey, value) {
    const scoped = ensureScopedSettings(currentScope);

    if (!scoped) {
        return false;
    }

    scoped[placeholderKey] = sanitizePlaceholderValue(value);
    return true;
}

function ensureUsableCurrentScope() {
    const availability = getScopeAvailability(currentScope);

    if (availability.available) {
        return;
    }

    const fallbackOrder = ["chat", "char", "global"];

    for (const scope of fallbackOrder) {
        const available = getScopeAvailability(scope);

        if (available.available) {
            currentScope = scope;
            return;
        }
    }

    currentScope = "global";
}

function refreshScopeButtons() {
    if (!compactUIPopup) return;

    SCOPE_ORDER.forEach((scope) => {
        const btn = compactUIPopup.find(`.dm-compact--scope-btn[data-scope="${scope}"]`);
        const availability = getScopeAvailability(scope);
        btn.prop("disabled", !availability.available);
        btn.attr("title", getScopeButtonTitle(scope));
        btn.toggleClass("dm-compact--scope-btn--active", scope === currentScope);
    });
}

function refreshHistoryButtons() {
    if (!compactUIPopup) return;

    const placeholder = getPopupCurrentPlaceholder();
    const scopedValue = getCurrentScopeState(placeholder.key);
    const total = scopedValue.entries.length;
    const idx = scopedValue.activeIndex;

    compactUIPopup.find(".dm-compact--history-prev").prop("disabled", idx <= 0);
    compactUIPopup.find(".dm-compact--history-next").prop("disabled", idx >= total - 1);
    compactUIPopup.find(".dm-compact--history-count").text(`${idx + 1}/${total}`);
}

function getPresetList(placeholderKey, scope) {
    const settings = getSettings();
    settings.presets = sanitizePresets(settings.presets);
    return settings.presets[placeholderKey]?.[scope] || [];
}

function renderPresetSelect() {
    if (!compactUIPopup) return;

    const placeholder = getPopupCurrentPlaceholder();
    const select = compactUIPopup.find(".dm-compact--preset-select");
    const presets = getPresetList(placeholder.key, currentScope);
    const currentContent = getCurrentScopeState(placeholder.key).content;

    select.empty();
    select.append('<option value="">✨️ 어떤 지시를 내릴까?</option>');

    let matchedId = "";

    presets.forEach((preset) => {
        select.append(`<option value="${preset.id}">${escapeHtml(preset.name)}</option>`);

        if (!matchedId && currentContent && preset.content === currentContent) {
            matchedId = preset.id;
        }
    });

    select.val(matchedId);

    const hasSelection = Boolean(matchedId);
    compactUIPopup.find(".dm-compact--preset-rename").prop("disabled", !hasSelection);
    compactUIPopup.find(".dm-compact--preset-delete").prop("disabled", !hasSelection);
}

function updateAppliedIndicator() {
    if (!compactUIPopup) return;

    const placeholder = getPopupCurrentPlaceholder();
    const combined = resolveCombinedContent(placeholder.key);
    const activeScopes = new Set(combined.activeScopes);

    SCOPE_ORDER.forEach((scope) => {
        compactUIPopup
            .find(`.dm-compact--scope-btn[data-scope="${scope}"]`)
            .toggleClass("dm-compact--scope-btn--on", activeScopes.has(scope));
    });

    refreshHistoryButtons();
}

function syncPopupByCurrentState() {
    if (!compactUIPopup) return;

    ensureUsableCurrentScope();

    const currentPlaceholder = getPopupCurrentPlaceholder();
    const settings = getCurrentScopeState(currentPlaceholder.key);
    beginHistorySession(settings);

    compactUIPopup.find(".dm-compact--radio").prop("checked", settings.enabled);
    compactUIPopup
        .find(".dm-compact--textarea")
        .val(settings.content || "")
        .prop("disabled", !settings.enabled);

    compactUIPopup.toggleClass("dm-compact--hide-preset", currentScope === "chat");

    refreshScopeButtons();
    renderPresetSelect();
    updateAppliedIndicator();
}

function generatePresetId() {
    if (globalThis.crypto && typeof globalThis.crypto.randomUUID === "function") {
        return globalThis.crypto.randomUUID();
    }

    return `${Date.now()}-${Math.random()}`;
}

async function showNativeConfirm(header, text, popupOptions = {}) {
    isNativePopupOpen = true;

    try {
        return await Popup.show.confirm(header, text, popupOptions);
    } finally {
        isNativePopupOpen = false;
    }
}

async function showNativeInput(header, text, defaultValue = "", popupOptions = {}) {
    isNativePopupOpen = true;

    try {
        return await Popup.show.input(header, text, defaultValue, popupOptions);
    } finally {
        isNativePopupOpen = false;
    }
}

function escapeHtml(value) {
    return String(value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#39;");
}

function closeCompactUIPopup() {
    if (compactUIApplyDebounceTimer) {
        commitDirectionContentNow(getPopupCurrentPlaceholder());
    }

    flushHistorySession();

    if (compactUIPopup) {
        compactUIPopup.removeClass("dm-compact--active");

        setTimeout(() => {
            if (compactUIPopup) {
                compactUIPopup.remove();
                compactUIPopup = null;
            }
        }, 200);
    }

    if (compactUIButton) {
        // class 대신 data 속성 사용: 서드파티 UI 스크립트가 classList로 버튼을 식별하는 경우 위치 설정이 초기화되는 것을 방지
        compactUIButton.removeAttr("data-dm-popup-open");
    }

    $(document).off("click.compactUI");
    $(document).off("mouseup.dmResize touchend.dmResize");
}

function showCompactUIPopup() {
    if (compactUIPopup) {
        return closeCompactUIPopup();
    }

    const settings = getSettings();
    currentScope = settings.lastScope || "chat";
    ensureUsableCurrentScope();

    compactUIButton.attr("data-dm-popup-open", "true");

    const popupHtml = `
        <div class="dm-compact--popup">
            <div class="dm-compact--header">
                <input type="checkbox" class="dm-compact--radio" title="이 범위 켜기/끄기">
                <div class="dm-compact--title">🪄전개지시M</div>
                <div class="dm-compact--header-spacer"></div>
                <button class="dm-compact--history-btn dm-compact--history-prev" type="button" title="이전 내용 보기">
                    <i class="fa-solid fa-arrow-left"></i>
                </button>
                <span class="dm-compact--history-count"></span>
                <button class="dm-compact--history-btn dm-compact--history-next" type="button" title="다음 내용 보기">
                    <i class="fa-solid fa-arrow-right"></i>
                </button>
                <button class="dm-compact--nav dm-compact--clear" title="내용 지우기" type="button">
                    <i class="fa-solid fa-eraser"></i>
                </button>
            </div>

            <div class="dm-compact--scope-row">
                <button class="dm-compact--scope-btn" data-scope="global" type="button"><span class="dm-compact--scope-emoji">🌐</span>전역</button>
                <button class="dm-compact--scope-btn" data-scope="char" type="button"><span class="dm-compact--scope-emoji">🎭</span>캐릭터</button>
                <button class="dm-compact--scope-btn" data-scope="chat" type="button"><span class="dm-compact--scope-emoji">🗨️</span>채팅</button>
            </div>

            <div class="dm-compact--preset-row">
                <select class="dm-compact--preset-select" aria-label="프리셋 선택"></select>
                <button class="dm-compact--preset-btn dm-compact--preset-save" type="button" title="현재 내용 프리셋 저장">
                    <i class="fa-solid fa-floppy-disk"></i>
                </button>
                <button class="dm-compact--preset-btn dm-compact--preset-rename" type="button" title="선택한 프리셋 이름 변경">
                    <i class="fa-solid fa-pen"></i>
                </button>
                <button class="dm-compact--preset-btn dm-compact--preset-delete" type="button" title="선택한 프리셋 삭제">
                    <i class="fa-solid fa-xmark"></i>
                </button>
            </div>

            <div class="dm-compact--content">
                <textarea class="dm-compact--textarea" placeholder="Direction 내용을 입력하세요..."></textarea>
            </div>
        </div>
    `;

    compactUIPopup = $(popupHtml);
    $("#nonQRFormItems").append(compactUIPopup);

    setTimeout(() => {
        if (compactUIPopup) {
            compactUIPopup.addClass("dm-compact--active");
        }
    }, 10);

    setupCompactUIEventListeners();
    syncPopupByCurrentState();

    cachedPresetRowHeight = measurePresetRowHeight();
    restoreTextareaHeightForCurrentScope();
    applyTextareaHeightCap();
}

function setupCompactUIEventListeners() {
    if (!compactUIPopup) return;

    // touchstart에서 preventDefault로 textarea blur(키보드 닫힘)를 막고 핸들러를 직접 실행한 뒤,
    // 뒤따르는 click은 무시한다(중복 실행 방지). 마우스 환경에서는 click만 사용된다.
    function bindTapAction(selector, handler) {
        let suppressNextClick = false;

        compactUIPopup.on("touchstart", selector, function (e) {
            if ($(this).prop("disabled")) return;
            e.preventDefault();
            suppressNextClick = true;
            setTimeout(() => { suppressNextClick = false; }, 400);
            handler.call(this, e);
        });

        compactUIPopup.on("mousedown", selector, (e) => {
            e.preventDefault();
        });

        compactUIPopup.on("click", selector, function (e) {
            if (suppressNextClick) {
                suppressNextClick = false;
                return;
            }
            handler.call(this, e);
        });
    }

    bindTapAction(".dm-compact--scope-btn", function () {
        const nextScope = $(this).data("scope");
        const availability = getScopeAvailability(nextScope);

        if (!availability.available) {
            return;
        }

        flushHistorySession();

        const textarea = compactUIPopup.find(".dm-compact--textarea");
        const outgoingGroup = textareaHeightGroup(currentScope);
        compactUITextareaHeights[outgoingGroup] = textarea.length ? textarea[0].style.height : "";

        currentScope = nextScope;
        getSettings().lastScope = nextScope;
        saveSettingsDebounced();
        syncPopupByCurrentState();

        restoreTextareaHeightForCurrentScope();
    });

    bindTapAction(".dm-compact--history-prev", () => navigateHistory(-1));
    bindTapAction(".dm-compact--history-next", () => navigateHistory(1));

    compactUIPopup.find(".dm-compact--radio").on("change", function () {
        const isEnabled = $(this).is(":checked");
        const currentPlaceholder = getPopupCurrentPlaceholder();
        const scopedValue = getCurrentScopeState(currentPlaceholder.key);
        scopedValue.enabled = isEnabled;

        if (!setCurrentScopeState(currentPlaceholder.key, scopedValue)) {
            console.warn(`${LOG_PREFIX} 현재 스코프에 값을 저장하지 못했습니다.`);
            return;
        }

        const textarea = compactUIPopup.find(".dm-compact--textarea");
        textarea.prop("disabled", !isEnabled);

        applyPlaceholderToSystem(currentPlaceholder);
        saveSettingsDebounced();
        updateAppliedIndicator();
    });

    // 체크박스도 터치 시 키보드가 닫히므로 직접 토글하고 change를 발생시킨다.
    compactUIPopup.on("touchstart", ".dm-compact--radio", function (e) {
        e.preventDefault();
        const checkbox = $(this);
        checkbox.prop("checked", !checkbox.prop("checked")).trigger("change");
    });

    compactUIPopup.on("mousedown", ".dm-compact--radio", (e) => {
        e.preventDefault();
    });

    // 채팅 탭에서 리사이즈 손잡이를 실제로 드래그했는지 감지 (모서리 근처 터치 + 높이 변화 둘 다 확인)
    compactUIPopup.on("mousedown touchstart", ".dm-compact--textarea", function (e) {
        if (currentScope !== "chat" || chatHeightIsCustom) {
            resizeCandidateHeight = null;
            return;
        }

        const point = (e.originalEvent && e.originalEvent.touches && e.originalEvent.touches[0]) || e.originalEvent || e;
        const rect = this.getBoundingClientRect();
        const nearResizeHandle = rect.right - point.clientX <= 20 && rect.bottom - point.clientY <= 20;

        resizeCandidateHeight = nearResizeHandle ? this.style.height : null;
    });

    $(document).on("mouseup.dmResize touchend.dmResize", () => {
        if (resizeCandidateHeight === null || !compactUIPopup) return;

        const textarea = compactUIPopup.find(".dm-compact--textarea")[0];

        if (textarea && textarea.style.height !== resizeCandidateHeight) {
            chatHeightIsCustom = true;
        }

        resizeCandidateHeight = null;
    });

    bindTapAction(".dm-compact--clear", function () {
        const currentPlaceholder = getPopupCurrentPlaceholder();
        const scopedValue = getCurrentScopeState(currentPlaceholder.key);

        // 지금 목록 순서는 그대로 두고, 맨 뒤에 빈 칸을 새로 추가해서 그 칸으로 이동한다.
        scopedValue.entries.push("");
        capEntries(scopedValue.entries);
        scopedValue.activeIndex = scopedValue.entries.length - 1;
        scopedValue.content = "";
        sessionSnapshot = null;

        if (!setCurrentScopeState(currentPlaceholder.key, scopedValue)) {
            console.warn(`${LOG_PREFIX} 현재 범위에 값을 저장하지 못했습니다.`);
            return;
        }

        compactUIPopup.find(".dm-compact--textarea").val("");
        applyPlaceholderToSystem(currentPlaceholder);
        saveSettingsDebounced();
        updateAppliedIndicator();
    });

    compactUIPopup.find(".dm-compact--textarea").on("input", function () {
        const newContent = String($(this).val());
        const currentPlaceholder = getPopupCurrentPlaceholder();
        const scopedValue = getCurrentScopeState(currentPlaceholder.key);
        const lastIndex = scopedValue.entries.length - 1;

        if (scopedValue.activeIndex !== lastIndex) {
            // 이전 칸을 보다가 수정: 기존 항목들은 그대로 두고 맨 뒤에 새 칸으로 분기한다.
            scopedValue.entries.push(newContent);
            capEntries(scopedValue.entries);
            scopedValue.activeIndex = scopedValue.entries.length - 1;
            sessionSnapshot = null;
        } else {
            scopedValue.entries[lastIndex] = newContent;
        }

        scopedValue.content = scopedValue.entries[scopedValue.activeIndex];

        if (!setCurrentScopeState(currentPlaceholder.key, scopedValue)) {
            console.warn(`${LOG_PREFIX} 현재 범위에 값을 저장하지 못했습니다.`);
            return;
        }

        // 매크로 재등록은 비용이 커서 입력이 250ms 멈췄을 때만 반영
        clearTimeout(compactUIApplyDebounceTimer);
        compactUIApplyDebounceTimer = setTimeout(() => {
            commitDirectionContentNow(currentPlaceholder);
        }, 250);

        saveSettingsDebounced();
    });

    compactUIPopup.find(".dm-compact--preset-select").on("change", function () {
        const presetId = String($(this).val() || "");
        const placeholder = getPopupCurrentPlaceholder();
        const presets = getPresetList(placeholder.key, currentScope);
        const selectedPreset = presets.find((preset) => preset.id === presetId);
        const hasSelection = Boolean(selectedPreset);

        compactUIPopup.find(".dm-compact--preset-rename").prop("disabled", !hasSelection);
        compactUIPopup.find(".dm-compact--preset-delete").prop("disabled", !hasSelection);

        if (!selectedPreset) {
            return;
        }

        compactUIPopup.find(".dm-compact--textarea").val(selectedPreset.content).trigger("input");
        commitDirectionContentNow(getPopupCurrentPlaceholder());
    });

    compactUIPopup.find(".dm-compact--preset-save").on("click", async () => {
        const placeholder = getPopupCurrentPlaceholder();
        const textareaValue = String(compactUIPopup.find(".dm-compact--textarea").val() || "");
        const select = compactUIPopup.find(".dm-compact--preset-select");
        const selectedPresetId = String(select.val() || "");

        const settings = getSettings();
        settings.presets = sanitizePresets(settings.presets);
        const presets = settings.presets[placeholder.key][currentScope];
        const selectedPreset = selectedPresetId ? presets.find((preset) => preset.id === selectedPresetId) : null;

        if (selectedPreset) {
            const overwrite = await showNativeConfirm(
                "프리셋 덮어쓰기",
                `선택된 프리셋 "${selectedPreset.name}"을(를) 지금 내용으로 덮어쓸까요?`,
                { okButton: "덮어쓰기", cancelButton: "새 프리셋 저장" }
            );

            if (overwrite) {
                selectedPreset.content = textareaValue;
                saveSettingsDebounced();
                renderPresetSelect();
                compactUIPopup.find(`.dm-compact--preset-select option[value="${selectedPreset.id}"]`).prop("selected", true);
                compactUIPopup.find(".dm-compact--preset-rename").prop("disabled", false);
                compactUIPopup.find(".dm-compact--preset-delete").prop("disabled", false);
                return;
            }
        }

        const name = await showNativeInput("새 프리셋", "새 프리셋 이름을 입력하세요:", "새 프리셋");

        if (!name || !name.trim()) {
            return;
        }

        presets.push({
            id: generatePresetId(),
            name: name.trim(),
            content: textareaValue,
        });

        saveSettingsDebounced();
        renderPresetSelect();
    });

    compactUIPopup.find(".dm-compact--preset-rename").on("click", async () => {
        const placeholder = getPopupCurrentPlaceholder();
        const select = compactUIPopup.find(".dm-compact--preset-select");
        const presetId = String(select.val() || "");

        if (!presetId) {
            return;
        }

        const presets = getPresetList(placeholder.key, currentScope);
        const target = presets.find((preset) => preset.id === presetId);

        if (!target) {
            return;
        }

        const newName = await showNativeInput("프리셋 이름 변경", "새 프리셋 이름을 입력하세요:", target.name);

        if (!newName || !newName.trim()) {
            return;
        }

        target.name = newName.trim();

        saveSettingsDebounced();
        renderPresetSelect();
        compactUIPopup.find(`.dm-compact--preset-select option[value="${presetId}"]`).prop("selected", true);
        compactUIPopup.find(".dm-compact--preset-rename").prop("disabled", false);
        compactUIPopup.find(".dm-compact--preset-delete").prop("disabled", false);
    });

    compactUIPopup.find(".dm-compact--preset-delete").on("click", async () => {
        const placeholder = getPopupCurrentPlaceholder();
        const select = compactUIPopup.find(".dm-compact--preset-select");
        const presetId = String(select.val() || "");

        if (!presetId) {
            return;
        }

        const confirmed = await showNativeConfirm("프리셋 삭제", "선택한 프리셋을 삭제하시겠습니까?");

        if (!confirmed) {
            return;
        }

        const settings = getSettings();
        settings.presets = sanitizePresets(settings.presets);
        settings.presets[placeholder.key][currentScope] = settings.presets[placeholder.key][currentScope]
            .filter((preset) => preset.id !== presetId);
        saveSettingsDebounced();
        renderPresetSelect();
    });

    $(document).on("click.compactUI", (e) => {
        if (isNativePopupOpen) {
            return;
        }

        if (!$(e.target).closest(".dm-compact--popup, .dm-compact--button").length) {
            closeCompactUIPopup();
        }
    });
}

function refreshPopupIfOpened() {
    if (!compactUIPopup) {
        return;
    }

    syncPopupByCurrentState();
}

function addCompactUIButton() {
    const ta = document.querySelector("#send_textarea");

    if (!ta) {
        setTimeout(addCompactUIButton, 1000);
        return;
    }

    if (compactUIButton) {
        compactUIButton.remove();
        compactUIButton = null;
    }

    const buttonHtml = `
        <div class="dm-compact--button menu_button" title="🪄전개지시M 빠른 편집">
            <i class="fa-solid fa-feather"></i>
        </div>
    `;

    compactUIButton = $(buttonHtml);
    $(ta).after(compactUIButton);

    const settings = getSettings();

    if (settings && settings.extensionEnabled) {
        compactUIButton.show();
    } else {
        compactUIButton.hide();
    }

    compactUIButton.on("click", showCompactUIPopup);
}

async function initializeExtensionMenu() {
    try {
        const html = await $.get(`/scripts/extensions/third-party/${extensionName}/settings.html`);
        $("#extensions_settings").append(html);

        updateExtensionMenuUI();

        setupExtensionMenuEventHandlers();

        console.log(`${LOG_PREFIX} 확장 메뉴 초기화 완료`);
    } catch (error) {
        console.error(`${LOG_PREFIX} 확장 메뉴 초기화 실패:`, error);
    }
}

function updateExtensionMenuUI() {
    const settings = getSettings();
    const prompts = normalizeDirectionPromptObject(settings.directionPrompt);

    $("#direction_manager_enabled").prop("checked", settings.extensionEnabled);

    $(".dm-prompt-tab-btn")
        .removeClass("dm-prompt-tab-btn--active")
        .filter(`[data-scope="${promptEditorScope}"]`)
        .addClass("dm-prompt-tab-btn--active");
    $("#direction_prompt_text").val(prompts[promptEditorScope] ?? "");

    $("#direction_prompt_depth_global").val(settings.promptDepth?.global ?? 1);
    $("#direction_prompt_depth_char").val(settings.promptDepth?.char ?? 1);
    $("#direction_prompt_depth_chat").val(settings.promptDepth?.chat ?? 1);
}

async function clearCurrentCharScopeData() {
    const key = getCurrentCharKey();

    if (!key) {
        toastr.warning("현재 캐릭터를 찾을 수 없습니다.");
        return;
    }

    const confirmed = await showNativeConfirm("캐릭터 데이터 삭제", "현재 캐릭터 전용 저장 내용을 삭제하시겠습니까?");

    if (!confirmed) {
        return;
    }

    const settings = getSettings();
    delete settings.chars[key];
    applyAllPlaceholders();
    saveSettingsDebounced();
    refreshPopupIfOpened();
}

async function clearCurrentChatScopeData() {
    const key = getCurrentChatKey();

    if (!key) {
        toastr.warning("현재 채팅을 찾을 수 없습니다.");
        return;
    }

    const confirmed = await showNativeConfirm("채팅 데이터 삭제", "현재 채팅 전용 저장 내용을 삭제하시겠습니까?");

    if (!confirmed) {
        return;
    }

    const settings = getSettings();
    delete settings.chats[key];
    applyAllPlaceholders();
    saveSettingsDebounced();
    refreshPopupIfOpened();
}

function setupExtensionMenuEventHandlers() {
    $("#direction_manager_enabled").on("change", function () {
        const isEnabled = $(this).is(":checked");
        getSettings().extensionEnabled = isEnabled;

        if (isEnabled) {
            if (compactUIButton) {
                compactUIButton.show();
            }

            applyAllPlaceholders();
        } else {
            if (compactUIButton) {
                compactUIButton.hide();

                if (compactUIPopup) {
                    closeCompactUIPopup();
                }
            }

            removeAllPlaceholders();
        }

        saveSettingsDebounced();
    });

    $(".dm-prompt-tab-btn").on("click", function () {
        promptEditorScope = String($(this).data("scope"));
        updateExtensionMenuUI();
    });

    $("#direction_prompt_text").on("input", function () {
        const settings = getSettings();
        settings.directionPrompt = normalizeDirectionPromptObject(settings.directionPrompt);
        settings.directionPrompt[promptEditorScope] = String($(this).val() ?? "");
        saveSettingsDebounced();
    });

    const bindScopeDepthInput = (scope, elementId) => {
        $(elementId).on("input", function () {
            const value = parseInt(String($(this).val()), 10);
            const settings = getSettings();
            settings.promptDepth = normalizePromptDepth(settings.promptDepth);
            settings.promptDepth[scope] = Number.isNaN(value) ? 1 : value;
            saveSettingsDebounced();
        });
    };

    bindScopeDepthInput("global", "#direction_prompt_depth_global");
    bindScopeDepthInput("char", "#direction_prompt_depth_char");
    bindScopeDepthInput("chat", "#direction_prompt_depth_chat");

    $("#direction_reset_prompt").on("click", function () {
        const settings = getSettings();
        settings.directionPrompt = { ...DEFAULT_DIRECTION_PROMPTS };
        settings.promptDepth = { global: 1, char: 1, chat: 1 };
        $("#direction_prompt_depth_global").val(1);
        $("#direction_prompt_depth_char").val(1);
        $("#direction_prompt_depth_chat").val(1);
        updateExtensionMenuUI();
        saveSettingsDebounced();
    });

    $("#direction_clear_char").on("click", clearCurrentCharScopeData);
    $("#direction_clear_chat").on("click", clearCurrentChatScopeData);
}

function handleContextChanged() {
    applyAllPlaceholders();
    refreshPopupIfOpened();
}

function injectDirectionPrompt(eventData) {
    const settings = getSettings();

    if (!settings.extensionEnabled) {
        return;
    }

    const messages = eventData.chat || eventData.messages;

    if (!messages || !Array.isArray(messages)) {
        return;
    }

    const templates = normalizeDirectionPromptObject(settings.directionPrompt);

    SCOPE_ORDER.forEach((scope) => {
        const value = getScopedPlaceholder(scope, "direction");

        if (!isValidEnabledContent(value)) {
            return;
        }

        const template = templates[scope];

        if (!template || template.trim() === "") {
            return;
        }

        const processedPrompt = template
            .replace(/\{\{direction\}\}/g, () => value.content.trim())
            .replace(/\{\{char\}\}/g, "")
            .replace(/\{\{user\}\}/g, "");

        const systemMessage = {
            role: "system",
            content: processedPrompt,
        };

        const depth = getScopeDepth(scope);

        if (depth === 0) {
            messages.push(systemMessage);
        } else {
            const insertIndex = Math.max(messages.length - depth, 0);
            messages.splice(insertIndex, 0, systemMessage);
        }
    });
}

jQuery(async () => {
    await loadSettings();
    applyAllPlaceholders();

    await initializeExtensionMenu();

    addCompactUIButton();

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, injectDirectionPrompt);
    eventSource.on(event_types.CHAT_CHANGED, handleContextChanged);

    if (event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, handleContextChanged);
    }
});
