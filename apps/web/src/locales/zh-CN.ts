/**
 * Simplified Chinese — the source of truth for the catalog schema.
 *
 * `en.ts` is typed as `typeof` this object, so a key added here and forgotten there is a
 * `vue-tsc` error (`pnpm typecheck`). The reverse direction — a key in `en` that is not
 * here — is caught by `test/i18n/catalog.test.ts`, which also checks placeholder parity.
 *
 * Key paths are **domain-first** (`chat.titleHint`, `tools.name.write_file`), never keyed
 * by the component file that happens to use them: components get split and renamed, and a
 * file-keyed catalog turns every refactor into a catalog migration.
 *
 * Two message-syntax traps, both of which fail *silently*:
 *   - `|` separates plural branches. A literal `|` in a message must be escaped `{'|'}`.
 *   - `{` `}` open an interpolation. A literal brace must be escaped `{'{'}` / `{'}'}`.
 * Chinese punctuation (`（）` `「」` `·`) needs no escaping, so this catalog is unaffected
 * so far — but keep the rule in mind for a message that quotes code or a template.
 *
 * Plural is a *catalog* concern, not a call-site concern: `en` messages use `|` branches,
 * `zh` messages never do, and both are called as `t(key, count, { …params })`.
 */
export default {
  app: {
    /** Shown when there is no session and no workspace to name the topbar after. */
    title: "guided-learning",
    configBanner: {
      before: "⚠ 尚未配置可用的 API Key。点击右上角",
      action: "⚙ 设置 → Providers",
      after: "添加一个 Provider 并填入 Key，保存后即刻生效。",
    },
  },

  /**
   * Autonyms, deliberately untranslated in both catalogs: a language picker that says
   * "Chinese" to someone who reads no English is useless. `locale.zhCN` is the single
   * legitimate CJK value in `en.ts`, and the catalog test allowlists it.
   */
  locale: {
    switchLabel: "语言",
    zhCN: "中文",
    en: "English",
  },

  theme: {
    light: "浅色",
    dark: "深色",
    auto: "自动",
    /** Reads clearer than a bare "自动" when the OS is doing the deciding. */
    autoCurrent: "自动（当前{current}）",
    toggleTitle: "主题：{label}（点击切换）",
  },

  chat: {
    titleHint: "标题由 AI 自动生成，修改后将不再自动更新",
  },

  /**
   * One message per `ApiErrorCode`. The catalog test iterates the shared union, so a code
   * added there without a message here fails the suite.
   */
  errors: {
    NAME_REQUIRED: "名称不能为空。",
    WORKSPACE_NOT_FOUND: "工作区不存在，可能已被删除。",
    COPILOT_NOT_FOUND: "Copilot 不存在，可能已被删除。",
    SESSION_NOT_FOUND: "会话不存在，可能已被删除。",
    TITLE_EMPTY: "标题不能为空。",
    UNSUPPORTED_FILE_TYPE: "不支持该文件类型：{mimeType}",
    INVALID_ATTACHMENT_PATH: "附件路径无效。",
    ATTACHMENT_NOT_FOUND: "附件不存在，可能已被删除。",
    ATTACHMENT_STORE_FAILED: "附件保存失败，请重试。",
    DATA_REQUIRED: "缺少文件内容。",
    INVALID_BASE64: "文件内容不是合法的 base64 编码。",
    EMPTY_FILE: "文件是空的。",
    FILE_TOO_LARGE: "文件超过 {limitMb} MB 限制。",
    PROVIDER_NOT_FOUND: "Provider 不存在，可能已被删除。",
    MODEL_NOT_FOUND: "模型不存在或已被移除。",
    MODEL_ID_REQUIRED: "每个模型都需要填写 modelId。",
    BASE_URL_REQUIRED: "Base URL 不能为空。",
    ONLY_PROVIDER: "不能删除唯一的 Provider。",
    DEFAULT_PROVIDER: "这是默认 Provider，请先选择另一个默认 Provider。",
    PARSER_NOT_FOUND: "解析服务不存在，可能已被删除。",
    UNKNOWN_PARSER_KIND: "未知的解析服务类型：{kind}",
    UNKNOWN_POLICY: "未知的解析策略：{policy}",
    UNKNOWN_PARSER: "未知的解析服务。",
    UNKNOWN_PROVIDER: "未知的 Provider。",
    MESSAGE_REQUIRED: "消息内容不能为空。",
  },

  /**
   * One message per `ParseErrorCode`. `{detail}` is only present for `cloud_failed` and
   * `corrupt` — the two codes whose sentence cannot stand without the provider's words.
   */
  parseErrors: {
    password_protected: "文件已加密，需要密码才能读取内容。",
    no_text_layer: "未检测到文本层，可能是扫描件或纯图片 PDF。可配置支持 OCR 的云解析服务后重试。",
    too_large: "文件超过本地解析上限，已跳过解析。可配置云解析服务后重试，或开启更高上限。",
    unsupported_type: "暂不支持解析该文件类型。",
    corrupt: "文件无法读取：{detail}",
    missing_file: "文件已丢失，无法解析。请重新上传。",
    no_cloud_parser: "没有可用的云解析服务。请到「设置 → 文档解析」添加一个并启用。",
    local_disabled: "本地解析已在设置中关闭。",
    cloud_auth: "云解析服务拒绝了凭据，请检查 API Key。",
    cloud_failed: "云解析失败：{detail}",
    timeout: "解析超时。文件可能过大，或解析服务无响应。",
    cancelled: "解析已取消。",
  },
};
