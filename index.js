// 🪄전개지시M 확장 - direction 플레이스홀더 관리 (컴팩트 UI 전용)
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid } from "../../../../script.js";
import { Popup } from "../../../popup.js";

// 확장 설정
const extensionName = "Direction-Manager-DB";
const LOG_PREFIX = "[🪄전개지시M]";

// 기본 Direction 프롬프트 (범위별로 따로 관리)
// - 채팅: 예전부터 쓰던 "다음 채팅에 반영할 지시" 문구를 그대로 유지
// - 전역/캐릭터: 채팅용 문구의 핵심 지침(직접 인용하지 말고 자연스럽게 녹여낼 것)을
//   각자의 목적에 맞게 반영해서 새로 작성
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

// 구버전(v4 이전) 호환용 별칭: 그때는 프롬프트가 하나였고, 그 기본값이 지금의 "채팅" 기본값과 같다.
const DEFAULT_DIRECTION_PROMPT = DEFAULT_DIRECTION_PROMPT_CHAT;

const DEFAULT_DIRECTION_PROMPTS = {
    global: DEFAULT_DIRECTION_PROMPT_GLOBAL,
    char: DEFAULT_DIRECTION_PROMPT_CHAR,
    chat: DEFAULT_DIRECTION_PROMPT_CHAT,
};

function defaultPlaceholderState() {
    return {
        enabled: false,
        content: "",
        previousContent: "",
    };
}

// 범위별 프롬프트 라벨 (합쳐진 {{direction}} 매크로 등에서 AI가 성격이 다른 지시임을 구분하도록)
const SCOPE_LABELS = {
    global: "[Format Rules]",
    char: "[Character Notes]",
    chat: "[Director's Note]",
};

const SCOPE_ORDER = ["global", "char", "chat"];
const SCOPE_DISPLAY_NAMES = { global: "전역", char: "캐릭터", chat: "채팅" };

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
    // 확장 메뉴 설정
    extensionEnabled: true,
    // 범위(전역/캐릭터/채팅)별로 완전히 다른 프롬프트 템플릿을 따로 쓴다.
    directionPrompt: { ...DEFAULT_DIRECTION_PROMPTS },
    // 범위별로 서로 다른 삽입 위치(Depth)를 쓸 수 있다.
    // 0: Chat History 끝에 삽입, >0: 끝에서부터 N번째 위치에 삽입
    promptDepth: { global: 1, char: 1, chat: 1 },
    // 팝업을 열 때 마지막으로 봤던 범위 탭을 기억해서 그대로 복원한다.
    lastScope: "chat",
    _migratedV2: false,
    _migratedV3: false,
    _migratedV4: false,
    _migratedV5: false,
};


let currentScope = "chat";
// 입력칸(textarea)을 드래그로 리사이즈했을 때, 전역/캐릭터는 높이를 공유하고
// 채팅만 따로 기억하기 위한 그룹 저장소. 드래그 리사이즈는 별도 이벤트가 없으므로
// 스코프를 전환하는 시점에 현재 높이를 읽어서 그룹별로 저장/복원한다.
function textareaHeightGroup(scope) {
    return scope === "chat" ? "chat" : "shared";
}
let compactUITextareaHeights = { shared: "", chat: "" };
// 현재 범위+플레이스홀더를 팝업에 불러온 시점의 content (이전 내용 추적용)
let editSessionSnapshot = null;
// ST 네이티브 Popup(확인/입력창)이 떠 있는 동안 true. 이 동안에는
// "바깥 클릭시 팝업 닫기" 핸들러가 컴팩트 UI를 닫지 않도록 막는다.
let isNativePopupOpen = false;
// 타이핑 중 매 키 입력마다 매크로를 재등록하면(registerMacro) 버벅일 수 있어서,
// 입력이 잠시 멈췄을 때 한 번만 실제로 반영되도록 디바운스한다.
let compactUIApplyDebounceTimer = null;
// 확장 설정 패널에서 지금 편집 중인 프롬프트 탭 (전역/캐릭터/채팅)
let promptEditorScope = "global";

// 플레이스홀더 정의
const placeholders = [
    { key: "direction", name: "🪄전개지시M", isCustom: true },
];

// 컴팩트 UI 관련 변수들
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
    return {
        enabled: Boolean(value?.enabled),
        content: typeof value?.content === "string" ? value.content : "",
        previousContent: typeof value?.previousContent === "string" ? value.previousContent : "",
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

// 프리셋을 전역/캐릭터/채팅 범위별로 분리해서 저장
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

    const pruneScope = (scopeState) => {
        if (!scopeState || typeof scopeState !== "object") return;

        if ("char" in scopeState) {
            delete scopeState.char;
            changed = true;
        }

        if ("user" in scopeState) {
            delete scopeState.user;
            changed = true;
        }
    };

    pruneScope(settings.global);

    Object.values(settings.chars || {}).forEach(pruneScope);
    Object.values(settings.chats || {}).forEach(pruneScope);

    if (settings.presets && typeof settings.presets === "object") {
        if ("char" in settings.presets) {
            delete settings.presets.char;
            changed = true;
        }

        if ("user" in settings.presets) {
            delete settings.presets.user;
            changed = true;
        }
    }

    if ("char" in settings) {
        delete settings.char;
        changed = true;
    }

    if ("user" in settings) {
        delete settings.user;
        changed = true;
    }

    return changed;
}

// 구버전엔 promptDepth가 숫자 하나였음 -> 전역/캐릭터/채팅 세 범위 모두에 그 값을 복사
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

// directionPrompt는 이제 범위별(전역/캐릭터/채팅) 템플릿 객체다. 값이 없거나 잘못돼 있으면
// 그 범위의 기본 템플릿으로 채운다.
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

// 캐릭터 카드 자체를 가리키는 원시 키 (아바타 파일명). "채팅 단위" 키를 만들 때 내부적으로만 사용한다.
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

// "캐릭터" 범위는 캐릭터 전체가 아니라, 채팅(chat) 범위처럼 지금 열려 있는
// 채팅방 안에서만 적용되어야 한다. 그래서 저장 키도 채팅 키와 동일하게 맞춘다.
// (저장소는 chars / chats 로 여전히 분리되어 있으므로 값이 섞이지는 않는다)
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

    // "캐릭터" 범위도 이제 채팅 범위와 마찬가지로 현재 채팅방이 있어야 사용 가능하다.
    if (scope === "char") {
        if (!getCurrentCharKey()) {
            return { available: false, reason: "현재 채팅을 찾을 수 없습니다" };
        }

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
    settings.lastScope = ["global", "char", "chat"].includes(settings.lastScope) ? settings.lastScope : "chat";
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

    // v1에 있던 {{char}} / {{user}} 저장값은 더 이상 사용하지 않으므로 삭제
    if (settings.char !== undefined) {
        delete settings.char;
    }

    if (settings.user !== undefined) {
        delete settings.user;
    }

    settings._migratedV2 = true;
    console.log(`${LOG_PREFIX} v1 설정을 v2 global 스코프로 마이그레이션했습니다. {{char}}/{{user}} 값은 제거했습니다.`);
    return true;
}

// v2까지는 프리셋이 스코프 구분 없이 하나의 목록이었음 -> 전역/캐릭터/채팅 3분할로 이전
// (기존 프리셋을 잃지 않도록 세 범위 모두에 복사해 넣음)
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

// v3까지 "캐릭터" 범위는 캐릭터 카드 전체(모든 채팅방 공용)로 저장되었다.
// v4부터는 채팅방 단위로 바뀌었는데, 예전 값은 "그 캐릭터의 어느 채팅방에서 썼는지"
// 기록이 없어(원래 모든 채팅방이 같은 값을 공유했음) 특정 채팅방으로 옮겨줄 수가 없다.
// 그래서 예전 형식(키에 "::"가 없는, 아바타 파일명만 있는 캐릭터 범위 데이터)은 정리한다.
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

// v4까지는 프롬프트 템플릿이 문자열 하나였고, 모든 범위가 그 템플릿을 그대로 반복해서 썼다.
// v5부터는 범위별로 완전히 다른 템플릿을 쓴다. 예전에 직접 고쳐 썼던 프롬프트가 있으면
// (기본값과 다르면) "채팅" 범위 것으로 그대로 옮겨준다 — 원래 이 문구 자체가
// "다음 채팅 지시"용으로 쓰여진 것이었기 때문이다. 전역/캐릭터는 새 기본 템플릿을 받는다.
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

// 설정 로드
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
        settings.global = settings.global || defaultScopeState();
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

// 전역/캐릭터/채팅 중 활성화되어 있고 내용이 있는 범위를 전부 모아서
// 라벨을 붙여 하나의 문자열로 합친다 (폴백이 아니라 동시 적용)
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

// 플레이스홀더를 시스템에 적용
// 대기 중인 디바운스를 취소하고, 지금 즉시 시스템(매크로)에 반영 + 표시 갱신
function commitDirectionContentNow(placeholder) {
    clearTimeout(compactUIApplyDebounceTimer);
    compactUIApplyDebounceTimer = null;
    applyPlaceholderToSystem(placeholder);
    updateAppliedIndicator();
}

function applyPlaceholderToSystem(placeholder) {
    const combined = resolveCombinedContent(placeholder.key);

    if (activeScopesEmpty(combined)) {
        removePlaceholderFromSystem(placeholder.key);
        return;
    }

    registerCustomPlaceholder(placeholder.key, combined.content);
}

function activeScopesEmpty(combined) {
    return !combined || !combined.activeScopes || combined.activeScopes.length === 0;
}

// 커스텀 플레이스홀더 등록
function registerCustomPlaceholder(key, content) {
    try {
        const context = getContext();

        if (context && context.registerMacro) {
            // 기존 매크로가 있으면 먼저 제거
            if (context.unregisterMacro) {
                context.unregisterMacro(key);
            }

            context.registerMacro(key, content || "", `🪄전개지시M: ${key}`);
        }
    } catch (error) {
        console.warn(`${LOG_PREFIX} Failed to register custom placeholder:`, error);
    }
}

// 시스템에서 플레이스홀더 제거
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

// 모든 플레이스홀더 적용
function applyAllPlaceholders() {
    placeholders.forEach((placeholder) => {
        applyPlaceholderToSystem(placeholder);
    });
}

// 모든 플레이스홀더 제거
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

    // 지금 범위를 못 쓰면 채팅 > 캐릭터 > 전역 순으로 사용 가능한 범위를 찾는다.
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

    ["global", "char", "chat"].forEach((scope) => {
        const btn = compactUIPopup.find(`.dm-compact--scope-btn[data-scope="${scope}"]`);
        const availability = getScopeAvailability(scope);
        btn.prop("disabled", !availability.available);
        btn.attr("title", getScopeButtonTitle(scope));
        btn.toggleClass("dm-compact--scope-btn--active", scope === currentScope);
    });
}

// 이전/현재 내용 토글 버튼: 이 범위에 "이전 내용"이 없으면 비활성화
function refreshHistoryButtons() {
    if (!compactUIPopup) return;

    const placeholder = getPopupCurrentPlaceholder();
    const scopedValue = getCurrentScopeState(placeholder.key);
    const hasPrevious = Boolean(scopedValue.previousContent);

    compactUIPopup.find(".dm-compact--history-prev, .dm-compact--history-next").prop("disabled", !hasPrevious);
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
    // 현재 범위에 적용되어 있는 내용과 똑같은 프리셋이 있으면
    // (재적용/재접속 시에도) 그 프리셋이 선택된 상태로 보여준다.
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
    let text = "⚪ 모든 범위 비활성";

    if (!activeScopesEmpty(combined)) {
        const names = combined.activeScopes.map((scope) => SCOPE_DISPLAY_NAMES[scope]).join(", ");
        text = `🟢 활성: ${names}`;
    }

    compactUIPopup.find(".dm-compact--indicator").text(text);
    refreshHistoryButtons();
}

function syncPopupByCurrentState() {
    if (!compactUIPopup) return;

    ensureUsableCurrentScope();

    const currentPlaceholder = getPopupCurrentPlaceholder();
    const settings = getCurrentScopeState(currentPlaceholder.key);
    editSessionSnapshot = settings.content;

    compactUIPopup.find(".dm-compact--title").text(currentPlaceholder.name);
    compactUIPopup.find(".dm-compact--radio").prop("checked", settings.enabled);
    compactUIPopup
        .find(".dm-compact--textarea")
        .val(settings.content || "")
        .prop("disabled", !settings.enabled);

    // 채팅 범위는 프리셋을 쓸 일이 없으므로 프리셋 줄을 숨기고, 그만큼의 공간을
    // 입력칸(textarea)을 늘리는 데 쓴다. 팝업 자체 크기는 세 범위 모두 동일하게 유지된다.
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

// ST 네이티브 확인창을 띄우는 동안 isNativePopupOpen을 true로 유지한다.
// (바깥 클릭시 컴팩트 UI가 같이 닫히는 문제 방지)
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

// 컴팩트 UI 팝업 닫기
function closeCompactUIPopup() {
    // 팝업을 닫는 시점에 아직 반영 안 된(디바운스 대기중인) 입력이 있으면 지금 바로 반영
    if (compactUIApplyDebounceTimer) {
        commitDirectionContentNow(getPopupCurrentPlaceholder());
    }

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
        // 클래스 대신 속성으로 표시: 서드파티 UI 커스텀 스크립트(예: 재단사)가
        // 버튼 classList를 기반으로 고유 키를 계산하는 경우, 클래스가 늘었다 줄었다
        // 하면 팝업 열림/닫힘에 따라 다른 버튼으로 인식되어 저장된 위치 설정이
        // 초기화되는 문제가 생길 수 있다. data 속성은 그런 키 계산에 영향을 주지 않는다.
        compactUIButton.removeAttr("data-dm-popup-open");
    }

    $(document).off("click.compactUI");
}

// 컴팩트 UI 팝업 표시
function showCompactUIPopup() {
    if (compactUIPopup) {
        return closeCompactUIPopup();
    }

    const settings = getSettings();
    // 마지막으로 보고 있던 범위 탭을 그대로 복원 (없으면 채팅 범위)
    currentScope = settings.lastScope || "chat";
    ensureUsableCurrentScope();

    compactUIButton.attr("data-dm-popup-open", "true");

    const popupHtml = `
        <div class="dm-compact--popup">
            <div class="dm-compact--header">
                <div class="dm-compact--title-row">
                    <input type="checkbox" class="dm-compact--radio">
                    <div class="dm-compact--title"></div>
                </div>
            </div>

            <div class="dm-compact--scope-row">
                <button class="dm-compact--scope-btn" data-scope="global" type="button">전역</button>
                <button class="dm-compact--scope-btn" data-scope="char" type="button">캐릭터</button>
                <button class="dm-compact--scope-btn" data-scope="chat" type="button">채팅</button>
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

            <div class="dm-compact--footer">
                <div class="dm-compact--indicator"></div>
                <div class="dm-compact--footer-actions">
                    <button class="dm-compact--history-btn dm-compact--history-prev" type="button" title="이전 내용 보기">
                        <i class="fa-solid fa-arrow-left"></i>
                    </button>
                    <button class="dm-compact--history-btn dm-compact--history-next" type="button" title="현재 내용 보기">
                        <i class="fa-solid fa-arrow-right"></i>
                    </button>
                    <button class="dm-compact--nav dm-compact--clear" title="내용 지우기" type="button">
                        <i class="fa-solid fa-eraser"></i>
                    </button>
                </div>
            </div>
        </div>
    `;

    compactUIPopup = $(popupHtml);
    $("#nonQRFormItems").append(compactUIPopup);

    // 애니메이션
    setTimeout(() => {
        if (compactUIPopup) {
            compactUIPopup.addClass("dm-compact--active");
        }
    }, 10);

    // 이벤트 핸들러 설정
    setupCompactUIEventListeners();
    syncPopupByCurrentState();
}

// 컴팩트 UI 이벤트 리스너 설정
function setupCompactUIEventListeners() {
    if (!compactUIPopup) return;

    compactUIPopup.find(".dm-compact--scope-btn").on("click", function () {
        const nextScope = $(this).data("scope");
        const availability = getScopeAvailability(nextScope);

        if (!availability.available) {
            return;
        }

        // 벗어나는 스코프가 속한 그룹의 지금 입력칸 높이를 기억해둔다.
        const textarea = compactUIPopup.find(".dm-compact--textarea");
        const outgoingGroup = textareaHeightGroup(currentScope);
        compactUITextareaHeights[outgoingGroup] = textarea.length ? textarea[0].style.height : "";

        currentScope = nextScope;
        getSettings().lastScope = nextScope;
        saveSettingsDebounced();
        syncPopupByCurrentState();

        // 전환해 들어온 스코프가 속한 그룹의 높이를 복원 (없으면 기본 크기로 돌아감)
        const incomingGroup = textareaHeightGroup(nextScope);
        if (textarea.length) {
            textarea[0].style.height = compactUITextareaHeights[incomingGroup] || "";
        }
    });

    // 이전 내용 <-> 현재 내용 토글 (두 버튼 모두 동일하게 내용을 맞바꿈)
    compactUIPopup.find(".dm-compact--history-prev, .dm-compact--history-next").on("click", () => {
        const placeholder = getPopupCurrentPlaceholder();
        const scopedValue = getCurrentScopeState(placeholder.key);

        if (!scopedValue.previousContent) {
            toastr.info("이 범위에 저장된 이전 내용이 없습니다.");
            return;
        }

        const swapped = {
            enabled: scopedValue.enabled,
            content: scopedValue.previousContent,
            previousContent: scopedValue.content,
        };

        if (!setCurrentScopeState(placeholder.key, swapped)) {
            console.warn(`${LOG_PREFIX} 현재 범위에 값을 저장하지 못했습니다.`);
            return;
        }

        compactUIPopup.find(".dm-compact--textarea").val(swapped.content);
        editSessionSnapshot = swapped.content;

        applyPlaceholderToSystem(placeholder);
        saveSettingsDebounced();
        updateAppliedIndicator();
    });

    // 라디오 버튼 변경 이벤트
    compactUIPopup.find(".dm-compact--radio").on("change", function () {
        const isEnabled = $(this).is(":checked");
        const currentPlaceholder = getPopupCurrentPlaceholder();
        const scopedValue = getCurrentScopeState(currentPlaceholder.key);
        scopedValue.enabled = isEnabled;

        if (!setCurrentScopeState(currentPlaceholder.key, scopedValue)) {
            console.warn(`${LOG_PREFIX} 현재 스코프에 값을 저장하지 못했습니다.`);
            return;
        }

        // 텍스트에어리어 활성화/비활성화
        const textarea = compactUIPopup.find(".dm-compact--textarea");
        textarea.prop("disabled", !isEnabled);

        applyPlaceholderToSystem(currentPlaceholder);
        saveSettingsDebounced();
        updateAppliedIndicator();
    });

    // 지우개 버튼: 확인창 없이 바로 삭제 (지우기 전 내용은 이전 내용으로 남아 화살표로 복원 가능)
    compactUIPopup.find(".dm-compact--clear").on("click", function () {
        const currentPlaceholder = getPopupCurrentPlaceholder();
        const scopedValue = getCurrentScopeState(currentPlaceholder.key);

        if (scopedValue.content) {
            scopedValue.previousContent = scopedValue.content;
        }

        scopedValue.content = "";

        if (!setCurrentScopeState(currentPlaceholder.key, scopedValue)) {
            console.warn(`${LOG_PREFIX} 현재 범위에 값을 저장하지 못했습니다.`);
            return;
        }

        compactUIPopup.find(".dm-compact--textarea").val("");
        editSessionSnapshot = "";
        applyPlaceholderToSystem(currentPlaceholder);
        saveSettingsDebounced();
        updateAppliedIndicator();
    });

    // 텍스트에어리어 변경 이벤트
    compactUIPopup.find(".dm-compact--textarea").on("input", function () {
        const newContent = String($(this).val());
        const currentPlaceholder = getPopupCurrentPlaceholder();
        const scopedValue = getCurrentScopeState(currentPlaceholder.key);

        // 이 편집 세션에서 처음으로 내용이 바뀌는 순간의 "이전 내용"을 1회만 보존
        if (editSessionSnapshot !== null && editSessionSnapshot !== newContent) {
            scopedValue.previousContent = editSessionSnapshot;
            editSessionSnapshot = null;
        }

        scopedValue.content = newContent;

        if (!setCurrentScopeState(currentPlaceholder.key, scopedValue)) {
            console.warn(`${LOG_PREFIX} 현재 범위에 값을 저장하지 못했습니다.`);
            return;
        }

        // registerMacro/unregisterMacro는 비용이 있는 작업이라 매 키 입력마다 실행하면
        // (특히 모바일에서) 타이핑이 버벅일 수 있다. 입력이 250ms 멈췄을 때만 반영한다.
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
        // 프리셋 선택은 타이핑이 아니라 즉시 반영되어야 자연스러우므로 디바운스를 건너뛴다.
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

        // 이미 선택된 프리셋이 있으면 새로 저장할지, 그 프리셋을 덮어쓸지 먼저 확인
        // (ST 자체 Popup 사용: 네이티브 confirm()은 모바일에서 키보드가 열렸다 닫히는 듯한 리플로우를 유발함)
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

        const settings = getSettings();
        settings.presets[placeholder.key][currentScope] = presets;
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

    // 외부 클릭시 닫기 (단, ST 네이티브 확인/입력창이 떠 있는 동안은 무시)
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

// 컴팩트 UI 버튼 추가
function addCompactUIButton() {
    const ta = document.querySelector("#send_textarea");

    if (!ta) {
        setTimeout(addCompactUIButton, 1000);
        return;
    }

    // 기존 버튼 제거
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

    // 확장 활성화 상태에 따라 버튼 표시/숨김
    const settings = getSettings();

    if (settings && settings.extensionEnabled) {
        compactUIButton.show();
    } else {
        compactUIButton.hide();
    }

    // 클릭 이벤트
    compactUIButton.on("click", showCompactUIPopup);
}

// 확장 메뉴 초기화
async function initializeExtensionMenu() {
    try {
        // HTML 로드 및 삽입
        const html = await $.get(`/scripts/extensions/third-party/${extensionName}/settings.html`);
        $("#extensions_settings").append(html);

        // UI 업데이트
        updateExtensionMenuUI();

        // 이벤트 핸들러 설정
        setupExtensionMenuEventHandlers();

        console.log(`${LOG_PREFIX} 확장 메뉴 초기화 완료`);
    } catch (error) {
        console.error(`${LOG_PREFIX} 확장 메뉴 초기화 실패:`, error);
    }
}

// 확장 메뉴 UI 업데이트
function updateExtensionMenuUI() {
    const settings = getSettings();
    const prompts = normalizeDirectionPromptObject(settings.directionPrompt);

    // 활성화 체크박스 상태 설정
    $("#direction_manager_enabled").prop("checked", settings.extensionEnabled);

    // 프롬프트 탭(전역/캐릭터/채팅) 활성 표시 + 지금 선택된 탭의 프롬프트 내용 표시
    $(".dm-prompt-tab-btn")
        .removeClass("dm-prompt-tab-btn--active")
        .filter(`[data-scope="${promptEditorScope}"]`)
        .addClass("dm-prompt-tab-btn--active");
    $("#direction_prompt_text").val(prompts[promptEditorScope] ?? "");

    // 범위별 Depth 설정
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

// 확장 메뉴 이벤트 핸들러 설정
function setupExtensionMenuEventHandlers() {
    // 활성화 체크박스 변경 이벤트 (전체 확장 기능 제어)
    $("#direction_manager_enabled").on("change", function () {
        const isEnabled = $(this).is(":checked");
        getSettings().extensionEnabled = isEnabled;

        if (isEnabled) {
            // 확장 활성화 시: 컴팩트 UI 버튼 표시 및 모든 플레이스홀더 적용
            if (compactUIButton) {
                compactUIButton.show();
            }

            applyAllPlaceholders();
        } else {
            // 확장 비활성화 시: 컴팩트 UI 버튼 숨김 및 모든 매크로 제거
            if (compactUIButton) {
                compactUIButton.hide();

                // 팝업이 열려있으면 닫기
                if (compactUIPopup) {
                    closeCompactUIPopup();
                }
            }

            removeAllPlaceholders();
        }

        saveSettingsDebounced();
    });

    // 프롬프트 탭(전역/캐릭터/채팅) 전환 이벤트
    $(".dm-prompt-tab-btn").on("click", function () {
        promptEditorScope = String($(this).data("scope"));
        updateExtensionMenuUI();
    });

    // 프롬프트 텍스트 변경 이벤트 (실시간 저장, 지금 선택된 탭에만 저장)
    $("#direction_prompt_text").on("input", function () {
        const settings = getSettings();
        settings.directionPrompt = normalizeDirectionPromptObject(settings.directionPrompt);
        settings.directionPrompt[promptEditorScope] = String($(this).val() ?? "");
        saveSettingsDebounced();
    });

    // 범위별 Depth 설정 변경 이벤트
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

    // 기본값 초기화 버튼 (세 범위 프롬프트 + Depth 전부 기본값으로)
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

// 프롬프트 주입 함수
// 전역/캐릭터/채팅은 각자 다른 Depth를 가질 수 있으므로, 활성화된 범위마다
// 별도의 system 메시지를 만들어 그 범위의 Depth 위치에 각각 삽입한다.
function injectDirectionPrompt(eventData) {
    const settings = getSettings();

    // 확장이 비활성화되어 있으면 주입하지 않음
    if (!settings.extensionEnabled) {
        return;
    }

    // 참고 파일 방식: eventData.chat 또는 eventData.messages 확인
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

        // 이 범위의 프롬프트 템플릿이 비어있으면 이 범위는 건너뜀 (다른 범위는 계속 진행)
        if (!template || template.trim() === "") {
            return;
        }

        // 플레이스홀더 치환 (각 범위는 자기 템플릿에만 자기 내용을 채운다 — 다른 범위와 합쳐지지 않음)
        const processedPrompt = template
            .replace(/\{\{direction\}\}/g, value.content.trim())
            // 예전에 커스텀 프롬프트에 남긴 흔적이 있어도 확장에서는 더 이상 처리하지 않음
            .replace(/\{\{char\}\}/g, "")
            .replace(/\{\{user\}\}/g, "");

        const systemMessage = {
            role: "system",
            content: processedPrompt,
        };

        const depth = getScopeDepth(scope);

        // 참고 파일의 방식을 따라 범위별 depth 적용
        if (depth === 0) {
            // 맨 끝에 추가
            messages.push(systemMessage);
        } else {
            // 끝에서부터 N번째 위치에 삽입
            const insertIndex = Math.max(messages.length - depth, 0);
            messages.splice(insertIndex, 0, systemMessage);
        }
    });
}

// 확장 초기화
jQuery(async () => {
    await loadSettings();
    applyAllPlaceholders();

    // 확장 메뉴 초기화
    await initializeExtensionMenu();

    // 컴팩트 UI 버튼 추가
    addCompactUIButton();

    // 프롬프트 주입 이벤트 리스너 등록
    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, injectDirectionPrompt);
    eventSource.on(event_types.CHAT_CHANGED, handleContextChanged);

    if (event_types.APP_READY) {
        eventSource.on(event_types.APP_READY, handleContextChanged);
    }
});
