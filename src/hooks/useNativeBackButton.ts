import { useEffect } from 'react';

type NativeBackPlugin = {
    addListener: (
        eventName: string,
        listener: () => void,
    ) => Promise<{ remove: () => Promise<void> }> | { remove: () => Promise<void> };
    exitApp: () => Promise<unknown>;
    moveTaskToBack?: () => Promise<unknown>;
    recordRuntimeDiagnostic?: (payload: {
        source: string;
        thread: string;
        type: string;
        message: string;
        stack: string;
    }) => Promise<unknown>;
};

const getPlugin = (): NativeBackPlugin | null => {
    if (typeof window === 'undefined') return null;
    const capacitor = (window as unknown as {
        Capacitor?: {
            getPlatform?: () => string;
            Plugins?: { FoliaNative?: NativeBackPlugin };
        };
    }).Capacitor;
    if (capacitor?.getPlatform?.() !== 'android') return null;
    const plugin = capacitor.Plugins?.FoliaNative;
    return plugin && typeof plugin.addListener === 'function' && typeof plugin.exitApp === 'function'
        ? plugin
        : null;
};

export type NativeBackOutcome = 'handled' | 'background' | 'exit';

/**
 * 返回键到底做什么。抽成纯函数是为了能直接测「无层可关时不再直接退出」这条策略。
 *
 * 有层消费：什么都不做（面板 / 设置子页 / 弹窗自己关掉）。
 * 没人消费：退到后台，让前台播放服务继续跑。以前这里直接 `exitApp()`，结束 Activity 会连带收掉
 * WebView 与播放服务，用户看到的就是「退出应用就自动暂停播放」。老桥没有 moveTaskToBack 时
 * 退回原来的退出行为，避免按返回键完全没反应。
 *
 * TV 体验补丁：没有层可关时，若上一次同状态返回距今不超过 2 秒（即「连按两次返回」），
 * 视为明确的退出意图，改走 exitApp() 真正结束 Activity 并连带停掉前台播放服务；
 * 单次返回仍退到后台，保留锁屏/后台听歌的使用习惯。
 */
export const applyNativeBackPress = (
    plugin: Pick<NativeBackPlugin, 'exitApp' | 'moveTaskToBack' | 'recordRuntimeDiagnostic'>,
    handled: boolean,
    now: number = Date.now(),
    lastUnhandledAtRef?: { value: number },
): NativeBackOutcome => {
    if (handled) {
        void plugin.recordRuntimeDiagnostic?.({
            source: 'activity-lifecycle',
            thread: 'webview',
            type: 'back-handled',
            message: 'A layer handled Escape',
            stack: '',
        }).catch(() => undefined);
        if (lastUnhandledAtRef) lastUnhandledAtRef.value = 0;
        return 'handled';
    }

    const canMoveToBackground = typeof plugin.moveTaskToBack === 'function';
    const lastUnhandledAt = lastUnhandledAtRef?.value ?? 0;
    const isDoublePress = lastUnhandledAt > 0 && now - lastUnhandledAt <= 2000;
    if (lastUnhandledAtRef) lastUnhandledAtRef.value = isDoublePress ? 0 : now;

    if (isDoublePress) {
        void plugin.recordRuntimeDiagnostic?.({
            source: 'activity-lifecycle',
            thread: 'webview',
            type: 'back-double-exit',
            message: 'Second unhandled Back within 2s; requesting app exit',
            stack: '',
        }).catch(() => undefined);
        void plugin.exitApp().catch(() => undefined);
        return 'exit';
    }

    void plugin.recordRuntimeDiagnostic?.({
        source: 'activity-lifecycle',
        thread: 'webview',
        type: 'back-to-background',
        message: canMoveToBackground
            ? 'No layer handled Escape; moving the task to the background'
            : 'No layer handled Escape; no background bridge available, requesting app exit',
        stack: '',
    }).catch(() => undefined);
    const action = canMoveToBackground ? plugin.moveTaskToBack!() : plugin.exitApp();
    void action.catch(() => undefined);
    return canMoveToBackground ? 'background' : 'exit';
};

/**
 * Routes the Android hardware Back through the same keyboard handling the app already uses for
 * Escape. Dialogs and nested settings views close themselves there; when no layer consumes the
 * event the app moves to the background instead of exiting, so playback keeps running.
 */
export const useNativeBackButton = (): void => {
    useEffect(() => {
        const plugin = getPlugin();
        if (!plugin) return;

        let disposed = false;
        let listenerHandle: { remove: () => Promise<void> } | { remove: () => void } | null = null;
        const lastUnhandledAtRef = { value: 0 };
        const registered = plugin.addListener('backButton', () => {
            if (disposed) return;
            const event = new KeyboardEvent('keydown', {
                key: 'Escape',
                code: 'Escape',
                bubbles: true,
                cancelable: true,
            });
            const handled = !window.dispatchEvent(event) || event.defaultPrevented;
            applyNativeBackPress(plugin, handled, Date.now(), lastUnhandledAtRef);
        });

        Promise.resolve(registered)
            .then(handle => {
                if (disposed) {
                    void handle.remove();
                    return;
                }
                listenerHandle = handle;
            })
            .catch(() => undefined);

        return () => {
            disposed = true;
            if (listenerHandle) void listenerHandle.remove();
        };
    }, []);
};
