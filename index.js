// 🪄전개지시M 확장 - direction 플레이스홀더 관리 (컴팩트 UI 전용)
import { extension_settings, getContext } from "../../../extensions.js";
import { saveSettingsDebounced, eventSource, event_types, characters, this_chid } from "../../../../script.js";

// 확장 설정
const extensionName = "Direction-Manager-DB";
const LOG_PREFIX = "[🪄전개지시M]";

// 기본 Direction 프롬프트
const DEFAULT_DIRECTION_PROMPT = `<direction>
- Resume the story based on the director's instructions below.
- The director only provides drafts; refine them into natural prose instead of directly quoting the sentences.
- Creatively construct and fill in any parts lacking persuasive causality so that the narrative suggested by the director unfolds smoothly.

[Direction(If blank, develop the story as you see fit): {{direction}}]
</direction>`;

function defaultPlaceholderState() {
    return {
        enabled: false,
        content: "",
        previousContent: "",
    };
}

// 범위별 프롬프트 라벨 (AI가 성격이 다른 지시임을 구분하도록)
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
    directionPrompt: DEFAULT_DIRECTION_PROMPT,
    promptDepth: 1, // 0: Chat History 끝에 삽입, >0: 끝에서부터 N번째 위치에 삽입
    defaultScope: "chat",
    _migratedV2: false,
    _migratedV3: false,
};

let currentScope = "chat";
// 현재 범위+플레이스홀더를 팝업에 불러온 시점의 content (이전 내용 추적용)
let editSessionSnapshot = null;

// 플레이스홀더 정의
const placeholders = [
    { key: "direction", name: "{{direction}}", isCustom: true },
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

function isGroupContext(context) {
    return Boolean(context?.groupId ?? context?.selected_group ?? context?.group?.id ?? context?.is_group);
}

function getCurrentCharKey() {
    const context = getContext();

    if (isGroupContext(context)) {
        return null;
    }

    if (this_chid != null && Array.isArray(characters) && characters[this_chid]) {
        return characters[this_chid].avatar || null;
    }

    return null;
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

    const charKey = getCurrentCharKey();

    if (!charKey) {
        return null;
    }

    return `${charKey}::${chatName}`;
}

function getScopeAvailability(scope) {
    if (scope === "global") {
        return { available: true, reason: "" };
    }

    if (scope === "char") {
        const context = getContext();

        if (isGroupContext(context)) {
            return { available: false, reason: "그룹 채팅에서는 캐릭터 범위를 사용할 수 없습니다" };
        }

        if (!getCurrentCharKey()) {
            return { available: false, reason: "현재 캐릭터를 찾을 수 없습니다" };
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
    settings.directionPrompt = typeof settings.directionPrompt === "string" ? settings.directionPrompt : defaultSettings.directionPrompt;
    settings.promptDepth = Number.isInteger(settings.promptDepth) ? settings.promptDepth : defaultSettings.promptDepth;
    settings.defaultScope = ["global", "char", "chat"].includes(settings.defaultScope) ? settings.defaultScope : defaultSettings.defaultScope;
    settings._migratedV2 = Boolean(settings._migratedV2);
    settings._migratedV3 = Boolean(settings._migratedV3);

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

// 설정 로드
async function loadSettings() {
    const settings = getSettings();

    if (Object.keys(settings).length === 0) {
        Object.assign(settings, cloneSettings(defaultSettings));
    }

    const migrated = migrateV1SettingsIfNeeded();
    const migratedV3 = migrateV3PresetsIfNeeded();
    const pruned = pruneRemovedPlaceholders();
    normalizeSettings();

    if (migrated || migratedV3 || pruned) {
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

    const defaultScope = getSettings().defaultScope;
    const fallbackOrder = [defaultScope, "chat", "char", "global"];

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

    select.empty();
    select.append('<option value="">선택...</option>');

    presets.forEach((preset) => {
        select.append(`<option value="${preset.id}">${preset.name}</option>`);
    });

    compactUIPopup.find(".dm-compact--preset-rename").prop("disabled", true);
    compactUIPopup.find(".dm-compact--preset-delete").prop("disabled", true);
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
        compactUIButton.removeClass("dm-compact--hasPopup");
    }

    $(document).off("click.compactUI");
}

// 컴팩트 UI 팝업 표시
function showCompactUIPopup() {
    if (compactUIPopup) {
        return closeCompactUIPopup();
    }

    const settings = getSettings();
    currentScope = settings.defaultScope;
    ensureUsableCurrentScope();

    compactUIButton.addClass("dm-compact--hasPopup");

    const popupHtml = `
        <div class="dm-compact--popup">
            <div class="dm-compact--header">
                <div class="dm-compact--title-row">
                    <input type="checkbox" class="dm-compact--radio">
                    <div class="dm-compact--title"></div>
                </div>
                <button class="dm-compact--nav dm-compact--clear" title="내용 지우기" type="button">
                    <i class="fa-solid fa-eraser"></i>
                </button>
            </div>

            <div class="dm-compact--scope-row">
                <span>범위:</span>
                <button class="dm-compact--scope-btn" data-scope="global" type="button">전역</button>
                <button class="dm-compact--scope-btn" data-scope="char" type="button">캐릭터</button>
                <button class="dm-compact--scope-btn" data-scope="chat" type="button">채팅</button>
                <button class="dm-compact--history-btn dm-compact--history-prev" type="button" title="이전 내용 보기">
                    <i class="fa-solid fa-arrow-left"></i>
                </button>
                <button class="dm-compact--history-btn dm-compact--history-next" type="button" title="현재 내용 보기">
                    <i class="fa-solid fa-arrow-right"></i>
                </button>
            </div>

            <div class="dm-compact--preset-row">
                <span>프리셋:</span>
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
            <div class="dm-compact--indicator"></div>
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

        currentScope = nextScope;
        syncPopupByCurrentState();
    });

    // 이전 내용 <-> 현재 내용 토글 (두 버튼 모두 동일하게 내용을 맞바꿈)
    compactUIPopup.find(".dm-compact--history-prev, .dm-compact--history-next").on("click", () => {
        const placeholder = getPopupCurrentPlaceholder();
        const scopedValue = getCurrentScopeState(placeholder.key);

        if (!scopedValue.previousContent) {
            alert("이 범위에 저장된 이전 내용이 없습니다.");
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

        applyPlaceholderToSystem(currentPlaceholder);
        saveSettingsDebounced();
        updateAppliedIndicator();
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
    });

    compactUIPopup.find(".dm-compact--preset-save").on("click", () => {
        const placeholder = getPopupCurrentPlaceholder();
        const textareaValue = String(compactUIPopup.find(".dm-compact--textarea").val() || "");
        const name = prompt("프리셋 이름을 입력하세요:", "새 프리셋");

        if (!name || !name.trim()) {
            return;
        }

        const settings = getSettings();
        settings.presets = sanitizePresets(settings.presets);
        settings.presets[placeholder.key][currentScope].push({
            id: generatePresetId(),
            name: name.trim(),
            content: textareaValue,
        });

        saveSettingsDebounced();
        renderPresetSelect();
    });

    compactUIPopup.find(".dm-compact--preset-rename").on("click", () => {
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

        const newName = prompt("새 프리셋 이름을 입력하세요:", target.name);

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

    compactUIPopup.find(".dm-compact--preset-delete").on("click", () => {
        const placeholder = getPopupCurrentPlaceholder();
        const select = compactUIPopup.find(".dm-compact--preset-select");
        const presetId = String(select.val() || "");

        if (!presetId) {
            return;
        }

        const confirmed = confirm("선택한 프리셋을 삭제하시겠습니까?");

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

    // 외부 클릭시 닫기
    $(document).on("click.compactUI", (e) => {
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

    // 활성화 체크박스 상태 설정
    $("#direction_manager_enabled").prop("checked", settings.extensionEnabled);

    // 프롬프트 텍스트 설정
    $("#direction_prompt_text").val(settings.directionPrompt || DEFAULT_DIRECTION_PROMPT);

    // Depth 설정
    $("#direction_prompt_depth").val(settings.promptDepth || 1);

    // 기본 스코프 설정
    $("#direction_default_scope").val(settings.defaultScope || "chat");
}

function clearCurrentCharScopeData() {
    const key = getCurrentCharKey();

    if (!key) {
        alert("현재 캐릭터를 찾을 수 없습니다.");
        return;
    }

    const confirmed = confirm("현재 캐릭터 전용 저장 내용을 삭제하시겠습니까?");

    if (!confirmed) {
        return;
    }

    const settings = getSettings();
    delete settings.chars[key];
    applyAllPlaceholders();
    saveSettingsDebounced();
    refreshPopupIfOpened();
}

function clearCurrentChatScopeData() {
    const key = getCurrentChatKey();

    if (!key) {
        alert("현재 채팅을 찾을 수 없습니다.");
        return;
    }

    const confirmed = confirm("현재 채팅 전용 저장 내용을 삭제하시겠습니까?");

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

    // 프롬프트 텍스트 변경 이벤트 (실시간 저장)
    $("#direction_prompt_text").on("input", function () {
        getSettings().directionPrompt = $(this).val();
        saveSettingsDebounced();
    });

    // Depth 설정 변경 이벤트
    $("#direction_prompt_depth").on("input", function () {
        const value = parseInt(String($(this).val()), 10);
        getSettings().promptDepth = Number.isNaN(value) ? 1 : value;
        saveSettingsDebounced();
    });

    // 기본 스코프 설정 변경 이벤트
    $("#direction_default_scope").on("change", function () {
        const value = String($(this).val());

        if (["global", "char", "chat"].includes(value)) {
            getSettings().defaultScope = value;
            saveSettingsDebounced();
        }
    });

    // 기본값 초기화 버튼
    $("#direction_reset_prompt").on("click", function () {
        $("#direction_prompt_text").val(DEFAULT_DIRECTION_PROMPT);
        $("#direction_prompt_depth").val(1);
        $("#direction_default_scope").val("chat");
        getSettings().directionPrompt = DEFAULT_DIRECTION_PROMPT;
        getSettings().promptDepth = 1;
        getSettings().defaultScope = "chat";
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
function injectDirectionPrompt(eventData) {
    const settings = getSettings();

    // 확장이 비활성화되어 있으면 주입하지 않음
    if (!settings.extensionEnabled) {
        return;
    }

    const combined = resolveCombinedContent("direction");

    // 활성화된 범위가 하나도 없으면 주입하지 않음
    if (activeScopesEmpty(combined)) {
        return;
    }

    // 프롬프트가 비어있으면 주입하지 않음
    if (!settings.directionPrompt || settings.directionPrompt.trim() === "") {
        return;
    }

    // 플레이스홀더 치환
    let processedPrompt = settings.directionPrompt;

    processedPrompt = processedPrompt
        .replace(/\{\{direction\}\}/g, combined.content || "")
        // 예전에 커스텀 프롬프트에 남긴 흔적이 있어도 확장에서는 더 이상 처리하지 않음
        .replace(/\{\{char\}\}/g, "")
        .replace(/\{\{user\}\}/g, "");

    const depth = settings.promptDepth || 1;

    // 참고 파일 방식: eventData.chat 또는 eventData.messages 확인
    const messages = eventData.chat || eventData.messages;

    if (messages && Array.isArray(messages)) {
        // system 메시지 생성
        const systemMessage = {
            role: "system",
            content: processedPrompt,
        };

        // 참고 파일의 방식을 따라 depth 적용
        if (depth === 0) {
            // 맨 끝에 추가
            messages.push(systemMessage);
        } else {
            // 끝에서부터 N번째 위치에 삽입
            const insertIndex = Math.max(messages.length - depth, 0);
            messages.splice(insertIndex, 0, systemMessage);
        }
    }
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
