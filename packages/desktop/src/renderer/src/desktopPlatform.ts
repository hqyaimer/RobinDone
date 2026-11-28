import { recordArmsCustomEventForE2E } from "@robindone/ui";
import {
  DesktopCommandIds,
  buildLocalMediaPreviewUrl,
  unwrapRemoteWorkspaceBindResult,
  type IPlatformService,
} from "@robindone/shared";

import { desktopBrowserPlatformBridge } from "./desktopBrowserPlatformBridge.js";
import { createDesktopPluginSandboxPlatform } from "./plugin-sandbox/desktopPluginSandboxPlatform.js";

export function createDesktopPlatform(options: {
  isLocalDevelopmentRuntime: boolean;
}): IPlatformService {
  return {
    canSelectFilePath: true,
    canOpenLocalFiles: true,
    pluginSandbox: createDesktopPluginSandboxPlatform(),
    createLocalMediaPreviewUrl: buildLocalMediaPreviewUrl,
    isLocalDevelopmentRuntime: options.isLocalDevelopmentRuntime,
    selectDirectory: () => window.robindone.selectDirectory(),
    selectDirectories: () => window.robindone.selectDirectories(),
    selectFile: () => window.robindone.selectFile(),
    selectFiles: () => window.robindone.selectFiles?.() ?? Promise.resolve([]),
    createTempTextAttachment: (payload) => window.robindone.createTempTextAttachment(payload),
    materializeWorkflowArtifactFile: (payload) =>
      window.robindone.materializeWorkflowArtifactFile(payload),
    onRemoteConnectionLog: (handler) => window.robindone.onRemoteConnectionLog(handler),
    onRemoteSessionClosed: (handler) => window.robindone.onRemoteSessionClosed(handler),
    // Source 自动重连会替换 logical session；统一由 preload bridge 转发换代事件。
    onRemoteSessionReconnected: (handler) =>
      window.robindone.onRemoteSessionReconnected?.(handler) ?? (() => {}),
    activateOrSetWorkspace: (path) =>
      window.robindone.activateOrSetWorkspace?.(path) ?? Promise.resolve({ activated: false }),
    connectRemote: (remoteOptions, requestId, context) =>
      window.robindone.connectRemote(remoteOptions, requestId, context),
    requestSourceSettingsAttachment: (sourceServerId) =>
      window.robindone.requestSourceSettingsAttachment?.(sourceServerId) ??
      Promise.reject(new Error("Source settings attachment bridge unavailable")),
    cancelPendingRemoteConnection: (requestId) =>
      window.robindone.cancelPendingRemoteConnection?.(requestId) ?? Promise.resolve(),
    bindRemoteWorkspaceSessionContext: async (context) => {
      if (!window.robindone.bindRemoteWorkspaceSessionContext) {
        throw new Error("Desktop bindRemoteWorkspaceSessionContext bridge unavailable");
      }
      // preload 返回结构化结果，在页面一侧还原错误才能保留 code/retryable。
      return unwrapRemoteWorkspaceBindResult(
        await window.robindone.bindRemoteWorkspaceSessionContext(context),
      );
    },
    startWebRemoteControl: (context) => window.robindone.startWebRemoteControl(context),
    stopWebRemoteControl: () => window.robindone.stopWebRemoteControl(),
    getWebRemoteControlStatus: () => window.robindone.getWebRemoteControlStatus(),
    onWebRemoteControlStatusChanged: (handler) =>
      window.robindone.onWebRemoteControlStatusChanged?.(handler) ?? (() => {}),
    disposeRemoteSession: (sessionId) => window.robindone.disposeRemoteSession(sessionId),
    isDockerAvailable: () => window.robindone.isDockerAvailable(),
    listWSLDistros: () => window.robindone.listWSLDistros(),
    listDockerContainers: () => window.robindone.listDockerContainers(),
    listSSHConfigAliases: () => window.robindone.listSSHConfigAliases(),
    loadMcpFromUserDirectory: (payload) => window.robindone.loadMcpFromUserDirectory(payload),
    saveMcpToUserDirectory: (payload) => window.robindone.saveMcpToUserDirectory(payload),
    migrateLegacyCommonMcp: (payload) => window.robindone.migrateLegacyCommonMcp(payload),
    openExternal: (url) => window.robindone.openExternal(url),
    openFeedback: () => window.robindone.executeDesktopCommand(DesktopCommandIds.OpenFeedback),
    openCommunity: () => window.robindone.executeDesktopCommand(DesktopCommandIds.OpenCommunity),
    canOpenCommunity: (locale) => window.robindone.canOpenCommunity(locale),
    openInFileManager: (path) => window.robindone.openInFileManager(path),
    openExternalFile: (path) => window.robindone.openExternalFile(path),
    openCuaPermissionOnboarding: window.robindone.openCuaPermissionOnboarding
      ? (permissionOptions) =>
          window.robindone.openCuaPermissionOnboarding?.(permissionOptions) ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    prepareCuaHelperPermissionDrag: window.robindone.prepareCuaHelperPermissionDrag
      ? () =>
          window.robindone.prepareCuaHelperPermissionDrag?.() ??
          Promise.resolve({ success: false, error: "not_supported" })
      : undefined,
    startCuaHelperPermissionDrag: window.robindone.startCuaHelperPermissionDrag
      ? () => window.robindone.startCuaHelperPermissionDrag?.()
      : undefined,
    notifyWebRemoteControlAuthStateChanged: (change) =>
      window.robindone.notifyWebRemoteControlAuthStateChanged(change),
    registerOAuthState: (payload) => window.robindone.registerOAuthState(payload),
    onOAuthCallback: (callback) => window.robindone.onOAuthCallback(callback),
    onPaymentCallback: (callback) => window.robindone.onPaymentCallback(callback),
    onShareImport: (callback) => window.robindone.onShareImport?.(callback) ?? (() => {}),
    notifyRendererReady: () => window.robindone.notifyRendererReady(),
    syncTelemetryContext: (context) => window.robindone.syncTelemetryContext(context),
    reportTelemetryEvent: (payload) => window.robindone.reportTelemetryEvent(payload),
    reportArmsCustomEvent: (payload) => {
      recordArmsCustomEventForE2E(payload);
      return window.robindone.reportArmsCustomEvent(payload);
    },
    getRendererActionTraceConfig: window.robindone.getRendererActionTraceConfig
      ? () => window.robindone.getRendererActionTraceConfig!()
      : undefined,
    onRendererActionTraceConfigChanged: window.robindone.onRendererActionTraceConfigChanged
      ? (callback) => window.robindone.onRendererActionTraceConfigChanged!(callback)
      : undefined,
    reportLocalTtftBatch: (batch) => window.robindone.reportLocalTtftBatch(batch),
    reportRendererActionTraceBatch: window.robindone.reportRendererActionTraceBatch
      ? (batch) => window.robindone.reportRendererActionTraceBatch!(batch)
      : undefined,
    reportRendererHeapSample: window.robindone.reportRendererHeapSample
      ? (sample) => window.robindone.reportRendererHeapSample!(sample)
      : undefined,
    showTaskNotification: (payload) => window.robindone.showTaskNotification(payload),
    syncWindowTabs: (paths) => window.robindone.syncWindowTabs(paths),
    syncWebRemoteControlWorkspaces: (workspaces) =>
      window.robindone.syncWebRemoteControlWorkspaces?.(workspaces),
    onWebRemoteControlReconnectWorkspace: (handler) =>
      window.robindone.onWebRemoteControlReconnectWorkspace?.(handler) ?? (() => {}),
    onWebRemoteControlRendererAction: (handler) =>
      window.robindone.onWebRemoteControlRendererAction?.(handler) ?? (() => {}),
    syncWindowUnreadCount: (count) => window.robindone.syncWindowUnreadCount(count),
    syncActiveTaskSession: (sessionId) => window.robindone.syncActiveTaskSession(sessionId),
    syncAppSettings: (patch) => window.robindone.syncAppSettings?.(patch),
    // 桥缺失（旧 preload 升级窗口）时按 supported 兜底，与 Windows 现状一致，设置开关可用。
    getCloseToTrayCapability: () =>
      window.robindone.getCloseToTrayCapability?.() ??
      Promise.resolve({ supported: true, gnomeLikeWithoutTray: false }),
    setShortcutRecordingActive: (active) => window.robindone.setShortcutRecordingActive?.(active),
    onFocusTab: (handler) => window.robindone.onFocusTab(handler),
    onNewTab: (handler) => window.robindone.onNewTab(handler),
    onCloseActiveContextRequest: (handler) =>
      window.robindone.onCloseActiveContextRequest?.(handler) ?? (() => {}),
    onOpenBrowserUrl: (handler) => window.robindone.onOpenBrowserUrl?.(handler) ?? (() => {}),
    onEmbeddedBrowserPermissionPrompt: (handler) =>
      window.robindone.onEmbeddedBrowserPermissionPrompt?.(handler) ?? (() => {}),
    resolveEmbeddedBrowserPermissionPrompt: (request) =>
      window.robindone.resolveEmbeddedBrowserPermissionPrompt?.(request),
    getEmbeddedBrowserSitePermissions: () =>
      window.robindone.getEmbeddedBrowserSitePermissions?.() ?? Promise.resolve({}),
    setEmbeddedBrowserSitePermission: (request) =>
      window.robindone.setEmbeddedBrowserSitePermission?.(request) ?? Promise.resolve({}),
    clearEmbeddedBrowserSitePermissions: () =>
      window.robindone.clearEmbeddedBrowserSitePermissions?.() ?? Promise.resolve({}),
    resetEmbeddedBrowserSitePermission: (request) =>
      window.robindone.resetEmbeddedBrowserSitePermission?.(request) ?? Promise.resolve({}),
    onBrowserViewScreenshotSurfacePrepare: (handler) =>
      window.robindone.onBrowserViewScreenshotSurfacePrepare?.(handler) ?? (() => {}),
    onBrowserViewScreenshotSurfaceRelease: (handler) =>
      window.robindone.onBrowserViewScreenshotSurfaceRelease?.(handler) ?? (() => {}),
    browserViewScreenshotSurfaceReady: (payload) =>
      window.robindone.browserViewScreenshotSurfaceReady?.(payload),
    ...desktopBrowserPlatformBridge,
    onNewTask: (handler) => window.robindone.onNewTask(handler),
    onOpenWorkspace: (handler) => {
      // 开发态或升级后的旧窗口可能仍运行未暴露 onOpenWorkspace 的 preload，
      // renderer 直接调用会在启动时崩溃。这里和 activateOrSetWorkspace 一样做兼容兜底，
      // 缺少该 bridge 时只禁用原生菜单回调，不影响应用继续打开。
      return window.robindone.onOpenWorkspace?.(handler) ?? (() => {});
    },
    onOpenWorkspacePath: (handler) => window.robindone.onOpenWorkspacePath?.(handler) ?? (() => {}),
    onOpenFeedbackDialog: (handler) =>
      window.robindone.onOpenFeedbackDialog?.(handler) ?? (() => {}),
    onOpenTicketsPanel: (handler) => window.robindone.onOpenTicketsPanel?.(handler) ?? (() => {}),
    onWindowFullscreenChanged: (handler) => window.robindone.onWindowFullscreenChanged(handler),
    getDesktopWindowChromeState: window.robindone.getDesktopWindowChromeState
      ? () => window.robindone.getDesktopWindowChromeState!()
      : undefined,
    onDesktopWindowChromeStateChanged: window.robindone.onDesktopWindowChromeStateChanged
      ? (handler) => window.robindone.onDesktopWindowChromeStateChanged!(handler)
      : undefined,
    getWindowControlsOverlayMetrics: () =>
      window.robindone.getWindowControlsOverlayMetrics?.() ?? null,
    onWindowControlsOverlayChanged: (handler) =>
      window.robindone.onWindowControlsOverlayChanged?.(handler) ?? (() => {}),
    getDesktopZoomLevel: () =>
      window.robindone.getDesktopZoomLevel?.() ?? Promise.resolve({ zoomLevel: 0 }),
    onDesktopZoomLevelChanged: (handler) =>
      window.robindone.onDesktopZoomLevelChanged?.(handler) ?? (() => {}),
    onTaskNotificationClick: (handler) => window.robindone.onTaskNotificationClick(handler),
    exportLogs: () => window.robindone.exportLogs(),
    captureWindowScreenshot: () =>
      window.robindone.captureWindowScreenshot?.() ?? Promise.resolve(null),
    onUpdateReady: (callback) => window.robindone.onUpdateReady(callback),
    onUpdateCheckResult: (callback) => window.robindone.onUpdateCheckResult(callback),
    onUpdateStateChanged: (callback) =>
      window.robindone.onUpdateStateChanged?.(callback) ?? (() => {}),
    getUpdateState: () =>
      window.robindone.getUpdateState?.() ?? Promise.resolve({ kind: "idle", enabled: true }),
    downloadUpdate: () => window.robindone.downloadUpdate?.() ?? Promise.resolve(),
    cancelUpdateDownload: () => window.robindone.cancelUpdateDownload?.() ?? Promise.resolve(),
    openUpdateStatusWindow: () => window.robindone.openUpdateStatusWindow?.() ?? Promise.resolve(),
    getAutoUpdatePreferences: () =>
      window.robindone.getAutoUpdatePreferences?.() ??
      Promise.resolve({ autoDownloadAndInstallUpdates: false }),
    setAutoDownloadAndInstallUpdates: (enabled) =>
      window.robindone.setAutoDownloadAndInstallUpdates?.(enabled) ?? Promise.resolve(),
    getDesktopSessionActivity: () =>
      window.robindone.getDesktopSessionActivity?.() ??
      Promise.resolve({ runningAgentSessionCount: 0 }),
    getRobinDoneStdioTapDevState: () =>
      window.robindone.getRobinDoneStdioTapDevState?.() ??
      Promise.resolve({ enabled: false, visible: false, logDir: "", statePath: "" }),
    onSettingsChanged: (callback) => window.robindone.onSettingsChanged?.(callback) ?? (() => {}),
    onApplicationLocaleChanged: (callback) =>
      window.robindone.onApplicationLocaleChanged?.(callback) ?? (() => {}),
    onPostUpdateReleaseNotes: (callback) => window.robindone.onPostUpdateReleaseNotes(callback),
    acknowledgePostUpdateReleaseNotes: (version) =>
      window.robindone.acknowledgePostUpdateReleaseNotes(version),
    skipUpdateVersion: (version) =>
      window.robindone.skipUpdateVersion?.(version) ?? Promise.resolve(),
    quitAndInstallUpdate: () => window.robindone.quitAndInstallUpdate(),
    getInstalledEditors: (filePath) => window.robindone.getInstalledEditors(filePath),
    getFileApplications: (target) => window.robindone.getFileApplications(target),
    openFileWithApplication: (applicationId, target) =>
      window.robindone.openFileWithApplication(applicationId, target),
    getApplicationIcon: (bundleId) =>
      window.robindone.getApplicationIcon?.(bundleId) ?? Promise.resolve(null),
    openInEditor: (editorId, path, editorOptions) =>
      window.robindone.openInEditor(editorId, path, editorOptions),
    executeDesktopCommand: (command) => window.robindone.executeDesktopCommand(command),
    setApplicationLocale: (locale) => window.robindone.setApplicationLocale(locale),
    getSystemLocale: () =>
      window.robindone.getSystemLocale?.() ??
      Promise.resolve(navigator.language.toLowerCase().startsWith("zh") ? "zh-CN" : "en-US"),
    setTitleBarTheme: (theme) => window.robindone.setTitleBarTheme(theme),
    getDeviceId: () =>
      (window as Window & { __ROBINDONE_DEVICE_ID__?: string }).__ROBINDONE_DEVICE_ID__ ?? "",
  };
}
