/*
 * Copyright (c) 2011-2017 gnome-pomodoro contributors
 *
 * This program is free software; you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <http://www.gnu.org/licenses/>.
 *
 * Authors: Kamil Prusko <kamilprusko@gmail.com>
 *
 */

const Signals = imports.signals;

const { Clutter, GLib, GObject, Meta, St } = imports.gi;

const Calendar = imports.ui.calendar;
const Main = imports.ui.main;
const MessageTray = imports.ui.messageTray;
const Params = imports.misc.params;
const Util = imports.misc.util;

const Extension = imports.misc.extensionUtils.getCurrentExtension();
const Config = Extension.imports.config;
const Timer = Extension.imports.timer;
const Utils = Extension.imports.utils;

const Gettext = imports.gettext.domain(Config.GETTEXT_PACKAGE);
const _ = Gettext.gettext;
const ngettext = Gettext.ngettext;


// Time to annouce next timer state.
const PRE_ANNOUCEMENT_TIME = 10.0;

const ICON_NAME = 'gnome-pomodoro-symbolic';


function getDefaultSource() {
    let extension = Extension.extension;
    let source = extension.notificationSource;

    if (!source) {
        source = new Source();
        let destroyId = source.connect('destroy',
            (source) => {
                if (extension.notificationSource === source) {
                    extension.notificationSource = null;
                }

                source.disconnect(destroyId);
            });

        extension.notificationSource = source;
    }

    return source;
}


function getCurrentNotification(notification) {
    if (Main.messageTray._notificationState === MessageTray.State.HIDDEN) {
        return null;
    }

    if (!(Main.messageTray._notification instanceof Notification)) {
        return null;
    }

    return Main.messageTray._notification;
}


var NotificationPolicy = GObject.registerClass({
    Properties: {
        'show-in-lock-screen': GObject.ParamSpec.boolean(
            'show-in-lock-screen', 'show-in-lock-screen', 'show-in-lock-screen',
            GObject.ParamFlags.READABLE, true),
        'details-in-lock-screen': GObject.ParamSpec.boolean(
            'details-in-lock-screen', 'details-in-lock-screen', 'details-in-lock-screen',
            GObject.ParamFlags.READABLE, true),
    },
}, class PomodoroNotificationPolicy extends MessageTray.NotificationPolicy {
    get showInLockScreen() {
        return true;
    }

    get detailsInLockScreen() {
        return true;
    }
});


var NotificationManager = class {
    constructor(timer) {
        this.timer = timer;
        this._timerStateChangedId = this.timer.connect('state-changed', this._onTimerStateChanged.bind(this));
        this._active = false;

        const messagesIndicatorPatch = new Utils.Patch(Main.panel.statusArea.dateMenu._indicator, {
            _sync() {
                this.icon_name = 'message-indicator-symbolic';
                this.visible = this._count > 0;
            }
        });
        messagesIndicatorPatch.connect('applied', () => {
            Main.panel.statusArea.dateMenu._indicator._sync();
        });
        messagesIndicatorPatch.connect('reverted', () => {
            Main.panel.statusArea.dateMenu._indicator._sync();
        });

        const messageTrayPatch = new Utils.Patch(Main.messageTray, {
            _expandBanner(autoExpanding) {
                // Don't auto expand pomodoro notifications, despite Urgency.CRITICAL.
                if (autoExpanding && this._notification instanceof Notification) {
                    return;
                }

                messageTrayPatch.initial._expandBanner.bind(this)(autoExpanding);
            }
        });

        const notificationSectionPatch = new Utils.Patch(Calendar.NotificationSection.prototype, {
            _onNotificationAdded(source, notification) {
                if (notification instanceof PomodoroEndNotification ||
                    notification instanceof PomodoroStartNotification)
                {
                    const message = new CalendarBanner(notification);

                    this.addMessageAtIndex(message, this._nUrgent, this.mapped);
                }
                else {
                    patch.initial._onNotificationAdded.bind(this)(source, notification);
                }
            }
        });

        this._messagesIndicatorPatch = messagesIndicatorPatch;
        this._messageTrayPatch = messageTrayPatch;
        this._notificationSectionPatch = notificationSectionPatch;

        this._onTimerStateChanged();
    }

    _showDoNotDisturbButton() {
        const dndButton = Main.panel.statusArea.dateMenu._messageList._dndButton;
        dndButton.show();

        for (const sibling of [dndButton.get_previous_sibling(), dndButton.get_next_sibling()]) {
            if (sibling instanceof St.Label) {
                sibling.show();
            }
        }
    }

    _hideDoNotDisturbButton() {
        const dndButton = Main.panel.statusArea.dateMenu._messageList._dndButton;
        dndButton.hide();

        for (const sibling of [dndButton.get_previous_sibling(), dndButton.get_next_sibling()]) {
            if (sibling instanceof St.Label) {
                sibling.hide();
            }
        }
    }

    _onTimerStateChanged() {
        if (this.timer.getState() !== Timer.State.NULL) {
            this.activate();
        }
        else {
            this.deactivate();
        }
    }

    activate() {
        if (!this._active) {
            this._active = true;
            this._messageTrayPatch.apply();
            this._messagesIndicatorPatch.apply();
            this._notificationSectionPatch.apply();
            this._hideDoNotDisturbButton();
        }
    }

    deactivate() {
        if (this._active) {
            this._active = false;
            this._messageTrayPatch.revert();
            this._messagesIndicatorPatch.revert();
            this._notificationSectionPatch.revert();
            this._showDoNotDisturbButton();
        }
    }

    destroy() {
        this.deactivate();

        if (this._timerStateChangedId) {
            this.timer.disconnect(this._timerStateChangedId);
            this._timerStateChangedId = 0;
        }

        this._messageTrayPatch.destroy();
        this._messagesIndicatorPatch.destroy();
        this._notificationSectionPatch.destroy();
    }
};


var Source = GObject.registerClass(
class PomodoroSource extends MessageTray.Source {
    _init() {
        super._init(_("Pomodoro Timer"), ICON_NAME);

        this._idleId = 0;

        this.connect('destroy', () => {
            if (this._idleId) {
                GLib.source_remove(this._idleId);
                this._idleId = 0;
            }

            this.destroyNotifications();
        });
    }

    /* override parent method */
    _createPolicy() {
        return new NotificationPolicy();
    }

    _lastNotificationRemoved() {
        this._idleId = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            if (this.notifications.length == 0) {
                this.destroy();
            }

            return GLib.SOURCE_REMOVE;
        });
        GLib.Source.set_name_by_id(this._idleId,
                                   '[gnome-pomodoro] this._lastNotificationRemoved');
    }

    /* override parent method */
    _onNotificationDestroy(notification) {
        let index = this.notifications.indexOf(notification);
        if (index < 0) {
            return;
        }

        this.notifications.splice(index, 1);
        this.countUpdated();

        if (this.notifications.length == 0) {
            this._lastNotificationRemoved();
        }
    }

    /* override parent method */
    showNotification(notification) {
        Extension.extension.ensureNotificationManager();

        super.showNotification(notification);
    }

    destroyNotifications() {
        let notifications = this.notifications.slice();

        notifications.forEach((notification) => {
            notification.destroy();
        });
    }
});


var Notification = GObject.registerClass(
class PomodoroNotification extends MessageTray.Notification {
    _init(title, description, params) {
        super._init(null, title, description, params);

        // Show notification regardless of session busy status.
        this.setForFeedback(true);

        this._destroying = false;

        // We want notifications to be shown right after the action,
        // therefore urgency bump.
        this.setUrgency(MessageTray.Urgency.HIGH);
    }

    activate() {
        super.activate();
        Main.panel.closeCalendar();
    }

    show() {
        if (!this.source) {
            this.source = getDefaultSource();
        }

        if (this.source) {
            this.acknowledged = false;

            if (!Main.messageTray.contains(this.source)) {
                Main.messageTray.add(this.source);
            }

            this.source.showNotification(this);
        }
        else {
            Utils.logWarning('Called Notification.show() after destroy()');
        }
    }

    _preventDestroy() {
        if (!this.resident && !this._destroying) {
            this.resident = true;

            GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
                this.resident = false;
            });
        }
    }

    // FIXME: We shouldn't override `destroy`. There may happen a second call
    // `.destroy(NotificationDestroyedReason.EXPIRED)`. I'm not sure if this bug is on our side or in MessageTray.
    destroy(reason = MessageTray.NotificationDestroyedReason.DISMISSED) {
        if (this._destroying) {
            Utils.logWarning('Already called Notification.destroy()');
            return;
        }
        this._destroying = true;

        super.destroy(reason);
    }
});


var PomodoroStartNotification = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class PomodoroStartNotification extends Notification {
    /**
     * Notification pops up a little before Pomodoro starts and changes message once started.
     */

    _init(timer) {
        super._init('', null, null);

        this.timer = timer;
        this._timerState = null;
        this._timerStateChangedId = this.timer.connect('state-changed', this._onTimerStateChanged.bind(this));

        this.connect('destroy', () => {
            if (this._timerStateChangedId != 0) {
                this.timer.disconnect(this._timerStateChangedId);
                this._timerStateChangedId = 0;
            }
        });

        this._onTimerStateChanged();
    }

    _onTimerStateChanged() {
        let title,
            message,
            resident,
            urgent,
            state = this.timer.getState();

        if (this._timerState !== state) {
            this._timerState = state;

            switch (state) {
                case Timer.State.SHORT_BREAK:
                case Timer.State.LONG_BREAK:
                    title = _("Break is about to end");
                    resident = false;
                    urgent = true;
                    break;

                case Timer.State.POMODORO:
                    title = _("Pomodoro");
                    resident = false;
                    urgent = false;
                    break;

                default:
                    // keep notification as is until destroyed
                    return;
            }

            this.title = title;
            this.setResident(resident);
            this.setTransient(!resident);

            // Bump to Urgency.CRITICAL so that notification has higher priority and that it would stay open.
            // It's abusive, but only for 10s.
            this.setUrgency(urgent ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.HIGH);

            if (Main.messageTray._notification === this) {
                Main.messageTray._updateNotificationTimeout(2000);
            }

            Main.messageTray._updateState();

            this.emit('changed');
        }
    }

    _getBodyText() {
        let remaining = Math.max(this.timer.getRemaining(), 0.0);
        let minutes = Math.round(remaining / 60);
        let seconds = Math.round(remaining % 60);

        return remaining > 45
                ? ngettext("%d minute remaining",
                           "%d minutes remaining", minutes).format(minutes)
                : ngettext("%d second remaining",
                           "%d seconds remaining", seconds).format(seconds);
    }

    /**
     * createBanner() is used only to display a notification popup.
     * Banners in calendar menu or the lock screen are made by GNOME Shell.
     */
    createBanner() {
        let banner,
            extendButton;

        banner = super.createBanner();
        banner.canClose = function() {
            return false;
        };

        let onTimerUpdate = () => {
            if (banner.bodyLabel) {
                let bodyText = this._getBodyText();

                if (bodyText !== banner._bodyText) {
                    banner._bodyText = bodyText;
                    banner.setBody(bodyText);
                }
            }

            // TODO: move this to notification, shouldn't handled by banner
            if (this.urgency === MessageTray.Urgency.CRITICAL && this.timer.getRemaining() > PRE_ANNOUCEMENT_TIME) {
                this.setUrgency(MessageTray.Urgency.HIGH);
            }
        };
        let onNotificationChanged = () => {
            banner.setTitle(this.title);
            banner.unexpand();

            if (this.timer.isBreak() && !extendButton) {
                extendButton = banner.addAction(_("+1 Minute"), () => {
                    this.timer.stateDuration += 60.0;
                    this._preventDestroy();
                });
            }
            else if (extendButton) {
                extendButton.destroy();
                extendButton = null;
            }
        };
        let onNotificationDestroy = () => {
            if (timerUpdateId != 0) {
                this.timer.disconnect(timerUpdateId);
                timerUpdateId = 0;
            }

            if (notificationChangedId != 0) {
                this.disconnect(notificationChangedId);
                notificationChangedId = 0;
            }

            if (notificationDestroyId != 0) {
                this.disconnect(notificationDestroyId);
                notificationDestroyId = 0;
            }
        };

        let timerUpdateId = this.timer.connect('update', onTimerUpdate);
        let notificationChangedId = this.connect('changed', onNotificationChanged);
        let notificationDestroyId = this.connect('destroy', onNotificationDestroy);

        banner.connect('destroy', () => onNotificationDestroy());

        onNotificationChanged();
        onTimerUpdate();

        return banner;
    }
});


var PomodoroEndNotification = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class PomodoroEndNotification extends Notification {
    _init(timer) {
        super._init('', null, null);

        this.timer = timer;
        this._timerState = null;
        this._timerStateChangedId = this.timer.connect('state-changed', this._onTimerStateChanged.bind(this));

        this.connect('destroy', () => {
            if (this._timerStateChangedId != 0) {
                this.timer.disconnect(this._timerStateChangedId);
                this._timerStateChangedId = 0;
            }
        });

        this._onTimerStateChanged();
    }

    _onTimerStateChanged() {
        let title,
            message,
            resident,
            urgent,
            state = this.timer.getState();

        if (this._timerState !== state) {
            this._timerState = state;

            switch (state) {
                case Timer.State.POMODORO:
                    title = _("Pomodoro is about to end");
                    resident = false;
                    urgent = true;
                    break;

                case Timer.State.SHORT_BREAK:
                case Timer.State.LONG_BREAK:
                    title = _("Take a break");
                    resident = true;
                    urgent = false;
                    break;

                default:
                    // keep notification as is until destroyed
                    return;
            }

            this.title = title;
            this.setResident(resident);
            this.setTransient(!resident);

            // Bump to Urgency.CRITICAL so that notification has higher priority and that it would stay open.
            // It's abusive, but only for 10s.
            this.setUrgency(urgent ? MessageTray.Urgency.CRITICAL : MessageTray.Urgency.HIGH);

            if (Main.messageTray._notification === this) {
                Main.messageTray._updateNotificationTimeout(2000);
            }

            Main.messageTray._updateState();

            this.emit('changed');
        }
    }

    _getBodyText() {
        let remaining = Math.max(this.timer.getRemaining(), 0.0);
        let minutes = Math.round(remaining / 60);
        let seconds = Math.round(remaining % 60);

        return remaining > 45
                ? ngettext("%d minute remaining",
                           "%d minutes remaining", minutes).format(minutes)
                : ngettext("%d second remaining",
                           "%d seconds remaining", seconds).format(seconds);
    }

    createBanner() {
        const initialState = this.timer.getState();

        const banner = super.createBanner();
        banner.canClose = function() {
            return false;
        };
        banner.addAction(_("Skip Break"), () => {
            banner.close();

            this.timer.setState(Timer.State.POMODORO);
        });
        banner.addAction(_("+1 Minute"), () => {
            this.timer.stateDuration += 60.0;
            this._preventDestroy();
        });

        let onTimerUpdate = () => {
            const updatesBlocked = banner.mapped && this.timer.getState() !== initialState;
            if (banner.bodyLabel && !updatesBlocked) {
                let bodyText = this._getBodyText();

                if (bodyText !== banner._bodyText) {
                    banner._bodyText = bodyText;
                    banner.setBody(bodyText);
                }
            }

            // TODO: move this to notification, shouldn't handled by banner
            if (this.urgency === MessageTray.Urgency.CRITICAL && this.timer.getRemaining() > PRE_ANNOUCEMENT_TIME) {
                this.setUrgency(MessageTray.Urgency.HIGH);
            }
        };
        let onNotificationChanged = () => {
            const state = this.timer.getState();
            const updatesBlocked = banner.mapped && state !== initialState;
            if (!updatesBlocked) {
                if (state === Timer.State.SHORT_BREAK || state === Timer.State.LONG_BREAK) {
                    banner.setTitle(Timer.State.label(state));
                }
                else {
                    banner.setTitle(this.title);
                }

                banner.unexpand();
            }
        };
        let onNotificationDestroy = () => {
            if (timerUpdateId != 0) {
                this.timer.disconnect(timerUpdateId);
                timerUpdateId = 0;
            }

            if (notificationChangedId != 0) {
                this.disconnect(notificationChangedId);
                notificationChangedId = 0;
            }

            if (notificationDestroyId != 0) {
                this.disconnect(notificationDestroyId);
                notificationDestroyId = 0;
            }
        };

        let timerUpdateId = this.timer.connect('update', onTimerUpdate);
        let notificationChangedId = this.connect('changed', onNotificationChanged);
        let notificationDestroyId = this.connect('destroy', onNotificationDestroy);

        banner.connect('destroy', () => onNotificationDestroy());

        onNotificationChanged();
        onTimerUpdate();

        return banner;
    }
});


var ScreenShieldNotification = GObject.registerClass({
    Signals: {
        'changed': {},
    },
}, class PomodoroScreenShieldNotification extends Notification {
    _init(timer) {
        super._init('', null, null);

        this.setTransient(false);
        this.setResident(true);

        // We want notifications to be shown right after the action,
        // therefore urgency bump.
        this.setUrgency(MessageTray.Urgency.HIGH);

        this.timer = timer;
        this.source = getDefaultSource();

        this._isPaused = false;
        this._timerState = Timer.State.NULL;
        this._timerUpdateId = this.timer.connect('update', this._onTimerUpdate.bind(this));

        this.connect('destroy', () => {
            if (this._timerUpdateId != 0) {
                this.timer.disconnect(this._timerUpdateId);
                this._timerUpdateId = 0;
            }
        });

        this._onTimerUpdate();
    }

    _onTimerStateChanged() {
        let state = this.timer.getState();
        let title = Timer.State.label(state);

        // HACK: "Pomodoro" in application name may be confusing with state name,
        //       so replace application name with current state.
        if (this.source !== null) {
            this.source.setTitle(title ? title : '');
        }

        Utils.wakeUpScreen();
    }

    _onTimerElapsedChanged() {
        let remaining = Math.max(this.timer.getRemaining(), 0.0);
        let minutes = Math.round(remaining / 60);
        let seconds = Math.round(remaining % 60);

        if (remaining > 15) {
            seconds = Math.ceil(seconds / 15) * 15;
        }

        this.bannerBodyText = (remaining > 45)
                ? ngettext("%d minute remaining",
                           "%d minutes remaining", minutes).format(minutes)
                : ngettext("%d second remaining",
                           "%d seconds remaining", seconds).format(seconds);
    }

    _onTimerUpdate() {
        let timerState = this.timer.getState(),
            isPaused = this.timer.isPaused(),
            bannerBodyText = this.bannerBodyText,
            stateChanged = false,
            elapsedChanged = false;

        if (this._timerState !== timerState || this._isPaused !== isPaused) {
            this._timerState = timerState;
            this._isPaused = isPaused;

            this._onTimerStateChanged();
            elapsedChanged = stateChanged = true;
        }

        this._onTimerElapsedChanged();

        if (this.bannerBodyText !== bannerBodyText) {
            elapsedChanged = true;
        }

        if (stateChanged) {
            // "updated" is original MessageTray.Notification signal
            // it indicates that content changed.
            this.emit('changed');

            // HACK: Force screen shield to update notification body
            if (this.source !== null) {
                this.source.notify('count');
            }
        }
        else if (elapsedChanged) {
            this.emit('changed');

            if (this.source !== null) {
                this.source.notify('count');
            }
        }
    }
});


var IssueNotification = GObject.registerClass(
class PomodoroIssueNotification extends MessageTray.Notification {
    /* Use base class instead of PomodoroNotification, in case
     * issue is caused by our implementation.
     */

    _init(message) {
        let source = getDefaultSource();
        let title  = _("Pomodoro Timer");
        let url    = Config.PACKAGE_BUGREPORT;

        super._init(source, title, message, { bannerMarkup: true });

        this.setTransient(true);
        this.setUrgency(MessageTray.Urgency.HIGH);

        this.addAction(_("Report issue"), () => {
                Util.trySpawnCommandLine('xdg-open ' + GLib.shell_quote(url));
                this.destroy();
            });
    }

    show() {
        if (!Main.messageTray.contains(this.source)) {
            Main.messageTray.add(this.source);
        }

        this.source.showNotification(this);
    }
});


var TimerBanner = GObject.registerClass(
class PomodoroTimerBanner extends Calendar.NotificationMessage {
    _init(notification) {
        super._init(notification);

        this.timer = notification.timer;

        this.setUseBodyMarkup(false);

        this._isPaused = null;
        this._timerState = null;
        this._timerUpdateId = this.timer.connect('update', this._onTimerUpdate.bind(this));
        this._onTimerUpdate();

        this.addAction(_("Skip"), () => {
                this.timer.skip();

                notification.destroy();
            });
        this.addAction(_("+1 Minute"), () => {
                this.timer.stateDuration += 60.0;
            });

        this.connect('close', this._onClose.bind(this));
    }

    /* override parent method */
    canClose() {
        return false;
    }

    addButton(button, callback) {
        button.connect('clicked', callback);
        this._mediaControls.add_actor(button);

        return button;
    }

    addAction(label, callback) {
        let button = new St.Button({ style_class: 'extension-pomodoro-message-action',
                                     label: label,
                                     x_expand: true,
                                     can_focus: true });

        return this.addButton(button, callback);
    }

    _getBodyText() {
        let remaining = Math.max(this.timer.getRemaining(), 0.0);
        let minutes = Math.round(remaining / 60);
        let seconds = Math.round(remaining % 60);

        return remaining > 45
                ? ngettext("%d minute remaining",
                           "%d minutes remaining", minutes).format(minutes)
                : ngettext("%d second remaining",
                           "%d seconds remaining", seconds).format(seconds);
    }

    _onTimerStateChanged() {
        let state = this.timer.getState();
        let title;

        if (this.timer.isPaused()) {
            title = _("Paused");
        }
        else {
            title = Timer.State.label(state);
        }

        if (title && this.titleLabel) {
            this.setTitle(title);
        }
    }

    _onTimerElapsedChanged() {
        if (this.bodyLabel) {
            let bodyText = this._getBodyText();

            if (bodyText !== this._bodyText) {
                this._bodyText = bodyText;
                this.setBody(bodyText);
            }
        }
    }

    _onTimerUpdate() {
        let timerState = this.timer.getState();
        let isPaused = this.timer.isPaused();

        if (this._timerState != timerState || this._isPaused != isPaused) {
            this._timerState = timerState;
            this._isPaused = isPaused;

            this._onTimerStateChanged();
        }

        if (this._timerState != Timer.State.NULL) {
            this._onTimerElapsedChanged();
        }
    }

    /* override parent method */
    _onUpdated(n, clear) {
    }

    _onClose() {
        if (this._timerUpdateId != 0) {
            this.timer.disconnect(this._timerUpdateId);
            this._timerUpdateId = 0;
        }
    }

    _onDestroy() {
        this._onClose();

        super._onDestroy();
    }
});
