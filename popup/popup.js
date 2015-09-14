window.fetch = undefined;
require('whatwg-fetch');

let Promise = require('es6-promise').Promise;
let bowser = require('bowser');
let trezor = require('trezor.js');
let {Session} = trezor;

global.alert = '#alert_loading';
global.device = null;

window.addEventListener('message', onMessage);
window.opener.postMessage('handshake', '*');

function onMessage(event) {
    let request = event.data;
    if (!request) {
        return;
    }

    if (bowser.msie) {
        showAlert('#alert_browser_unsupported');
        return;
    }

    request.identity = parseIdentity(event);
    document.querySelector('#origin').textContent = showIdentity(request.identity);

    switch (request.type) {

    case 'login':
        handleLogin(event);
        break;

    case 'xpubkey':
        handleXpubKey(event);
        break;

    case 'signtx':
        handleSignTx(event);
        break;

    default:
        console.warn('Unknown message', request);
    }
}

function respondToEvent(event, message) {
    let origin = (event.origin !== 'null') ? event.origin : '*';
    event.source.postMessage(message, origin);
}

function parseIdentity(event) {
    let identity = {};
    let origin = event.origin.split(':');

    identity.proto = origin[0];
    identity.host = origin[1].substring(2);
    if (origin[2]) {
        identity.port = origin[2];
    }
    identity.index = 0;

    return identity;
}

function showIdentity(identity) {
    let host = identity.host;
    let proto = (identity.proto !== 'https') ? (identity.proto + '://') : '';
    let port = (identity.port) ? (':' + identity.port) : '';
    return proto + host + port;
}

/*
 * login
 */

function handleLogin(event) {
    let request = event.data;

    if (request.icon) {
        document.querySelector('#header_icon').src = request.icon;
        show('#header_icon');
    }
    show('#operation_login');

    initDevice({ emptyPassphrase: true })

        .then(function signIdentity(device) { // send SignIdentity
            let handler = errorHandler(() => signIdentity(device));
            return device.session.signIdentity(
                request.identity,
                request.challenge_hidden,
                request.challenge_visual
            ).catch(handler);
        })

        .then((result) => { // success
            let {message} = result;
            let {public_key, signature} = message;

            respondToEvent(event, {
                success: true,
                public_key: public_key.toLowerCase(),
                signature: signature.toLowerCase(),
                version: 2      // since firmware 1.3.4
            });
        })

        .catch((error) => { // failure
            console.error(error);
            respondToEvent(event, {success: false, error: error.message});
        });
}

/*
 * xpubkey
 */

function handleXpubKey(event) {
    let path = event.data.path;
    if (path) {
        path = path.map((i) => i >>> 0);
    }

    show('#operation_xpubkey');

    initDevice()

        .then((device) => {
            let getPublicKey = (path) => {
                let handler = errorHandler(() => getPublicKey(path));
                return device.session.getPublicKey(path).catch(handler);
            };
            return alertExportXpubKey(path).then(getPublicKey);
        })

        .then((result) => { // success
            let {message} = result;
            var {xpub} = message;

            respondToEvent(event, {
                success: true,
                xpubkey: xpub,
                path: serializePath(path)
            });
        })

        .catch((error) => { // failure
            console.error(error);
            respondToEvent(event, {success: false, error: error.message});
        });
}

function alertExportXpubKey(path) {
    return new Promise((resolve, reject) => {
        let e = document.getElementById('xpubkey_id');
        e.textContent = xpubKeyLabel(path);
        e.callback = (exportXpub) => {
            if (exportXpub) {
                resolve(path);
            } else {
                reject(new Error('Cancelled'));
            }
        };
        showAlert('#alert_xpubkey');
    });
}

function exportXpubKey() {
    document.querySelector('#xpubkey_id').callback(true);
}

window.exportXpubKey = exportXpubKey;

function cancelXpubKey() {
    document.querySelector('#xpubkey_id').callback(false);
}

window.cancelXpubKey = cancelXpubKey;

let HD_HARDENED = 0x80000000;

function xpubKeyLabel(path) {
    let hardened = (i) => path[i] & ~HD_HARDENED;
    switch (hardened(0)) {
    case 44: return `Account #${hardened(2) + 1}`;
    case 45: return `Multisig wallet`;
    default: return serializePath(path);
    }
}

function serializePath(path) {
    return path.map((i) => {
        let s = (i & ~HD_HARDENED).toString();
        if (i & HD_HARDENED) {
            return s + "'";
        } else {
            return s;
        }
    }).join('/');
}

/*
 * signtx
 */

function handleSignTx(event) {
    let fix = (o) => {
        if (o.address_n) {
            // make sure bip32 indices are unsigned
            o.address_n = o.address_n.map((i) => i >>> 0);
        }
        return o;
    };
    let inputs = event.data.inputs.map(fix);
    let outputs = event.data.outputs.map(fix);
    let COIN_NAME = 'Bitcoin';

    show('#operation_signtx');

    initDevice()

        .then((device) => {
            let signTx = (refTxs) => {
                let handler = errorHandler(() => signTx(refTxs));
                return device.session.signTx(
                    inputs,
                    outputs,
                    refTxs,
                    device.getCoin(COIN_NAME)
                ).catch(handler);
            };
            return lookupReferencedTxs(inputs).then(signTx);
        })

        .then((result) => { // success
            let {message} = result;
            let {serialized} = message;

            respondToEvent(event, {
                success: true,
                type: 'signtx',
                signatures: serialized.signatures,
                serialized_tx: serialized.serialized_tx
            });
        })

        .catch((error) => { // failure
            console.error(error);
            respondToEvent(event, {success: false, error: error.message});
        });
}

function lookupReferencedTxs(inputs) {
    return Promise.all(inputs.map((input) => lookupTx(input.prev_hash)));
}

let INSIGHT_URL = 'https://insight.bitpay.com';

function lookupTx(hash) {
    return fetch(INSIGHT_URL + '/api/tx/' + hash)
        .then((response) => {
            if (response.status === 200) {
                return response;
            } else {
                throw new Error(response.statusText);
            }
        })
        .then((response) => response.json())
        .then((result) => ({
            hash: result.txid,
            version: result.version,
            lock_time: result.locktime,

            inputs_cnt: result.vin.length,
            inputs: result.vin.map((input) => {
                return {
                    prev_hash: input.txid,
                    prev_index: input.vin >>> 0,    // can be -1 in coinbase
                    sequence: input.sequence >>> 0, // usually -1, 0 in coinbase
                    script_sig: input.scriptSig.hex
                };
            }),

            outputs_cnt: result.vout.length,
            bin_outputs: result.vout.map((output) => {
                let amount = (output.value * 1e8) | 0;
                return {
                    amount: amount,
                    script_pubkey: output.scriptPubKey.hex
                };
            })
        }));
}

/*
 * device
 */

let NO_TRANSPORT = new Error('No trezor.js transport is available');
let NO_CONNECTED_DEVICES = new Error('No connected devices');
let DEVICE_IS_BOOTLOADER = new Error('Connected device is in bootloader mode');
let DEVICE_IS_EMPTY = new Error('Connected device is not initialized');
let FIRMWARE_IS_OLD = new Error('Firmware of connected device is too old');

function errorHandler(retry) {
    return (error) => {

        var never = new Promise(() => {});

        switch (error) { // application errors

        case NO_TRANSPORT:
            showAlert('#alert_transport_missing');
            return never;

        case NO_CONNECTED_DEVICES:
            showAlert('#alert_connect');
            return retry();

        case DEVICE_IS_BOOTLOADER:
            showAlert('#alert_reconnect');
            return retry();

        case DEVICE_IS_EMPTY:
            showAlert('#alert_device_empty');
            return never;

        case FIRMWARE_IS_OLD:
            showAlert('#alert_firmware_old');
            return never;
        }

        switch (error.code) { // 'Failure' messages

        case 'Failure_PinInvalid':
            showAlert('#alert_pin_invalid');
            return resolveAfter(2500).then(retry);
        }

        throw error;
    };
}

function initDevice({emptyPassphrase} = {}) {
    return initTransport()
        .then(waitForFirstDevice)
        .then((device) => {
            let passphraseHandler = (emptyPassphrase)
                ? emptyPassphraseCallback
                : passphraseCallback;

            device.session.on('passphrase', passphraseHandler);
            device.session.on('button', buttonCallback);
            device.session.on('pin', pinCallback);

            global.device = device;

            return device;
        });
}

function initTransport(configUrl = './../config_signed.bin') {
    let configure = (transport) => {
        return trezor.http(configUrl)
            .then((c) => transport.configure(c))
            .then(() => transport);
    };
    let result = trezor.loadTransport().then(configure).catch(() => {
        throw NO_TRANSPORT;
    });
    return result.catch(errorHandler());
}

class Device {

    constructor(session, features, accounts = []) {
        this.session = session;
        this.features = features;
        this.accounts = accounts;
    }

    static fromDescriptor(transport, descriptor) {
        return Device.acquire(transport, descriptor)
            .then(Device.fromSession);
    }

    static fromSession(session) {
        return session.initialize()
            .then((result) => new Device(session, result.message));
    }

    static acquire(transport, descriptor) {
        return transport.acquire(descriptor)
            .then((result) => new Session(transport, result.session));
    }

    isBootloader() {
        return this.features.bootloader_mode;
    }

    isInitialized() {
        return this.features.initialized;
    }

    getVersion() {
        return [
            this.features.major_version,
            this.features.minor_version,
            this.features.patch_version
        ].join('.');
    }

    atLeast(version) {
        return semvercmp(this.getVersion(), version) >= 0;
    }

    getCoin(name) {
        let coins = this.features.coins;
        for (let i = 0; i < coins.length; i++) {
            if (coins[i].coin_name === name) {
                return coins[i];
            }
        }
        throw new Error('Device does not support given coin type');
    }
}

function waitForFirstDevice(transport, waitBeforeRetry = 500) {
    let retryWait = () => {
        return resolveAfter(waitBeforeRetry).then(() => {
            return waitForFirstDevice(transport);
        });
    };

    return transport.enumerate().then((descriptors) => {
        if (descriptors.length === 0) {
            throw NO_CONNECTED_DEVICES;
        }
        return Device.fromDescriptor(transport, descriptors[0]).then((device) => {
            if (device.isBootloader()) {
                throw DEVICE_IS_BOOTLOADER;
            }
            if (!device.isInitialized()) {
                throw DEVICE_IS_EMPTY;
            }
            if (!device.atLeast('1.3.4')) {
                // 1.3.0 introduced PublicKey.xpub field
                // 1.3.4 has version2 of SignIdentity algorithm
                throw FIRMWARE_IS_OLD;
            }
            return device;
        });
    }).catch(errorHandler(retryWait));
}

/*
 * buttons
 */

function buttonCallback(code) {
    let receive = () => {
        global.device.session.removeListener('receive', receive);
        global.device.session.removeListener('error', receive);
        showAlert(global.alert);
    };
    global.device.session.on('receive', receive);
    global.device.session.on('error', receive);
    showAlert('#alert_confirm');
}

/*
 * pin
 */

function pinCallback(type, callback) {
    document.querySelector('#pin_dialog').callback = callback;
    window.addEventListener('keydown', pinKeydownHandler);
    showAlert('#pin_dialog');
}

function pinKeydownHandler(ev) {
    clickMatchingElement(ev, {
        8: '#pin_backspace',
        13: '#pin_enter button',
        // numeric
        49: '#pin_table button[key="1"]',
        50: '#pin_table button[key="2"]',
        51: '#pin_table button[key="3"]',
        52: '#pin_table button[key="4"]',
        53: '#pin_table button[key="5"]',
        54: '#pin_table button[key="6"]',
        55: '#pin_table button[key="7"]',
        56: '#pin_table button[key="8"]',
        57: '#pin_table button[key="9"]',
        // numpad
        97: '#pin_table button[key="1"]',
        98: '#pin_table button[key="2"]',
        99: '#pin_table button[key="3"]',
        100: '#pin_table button[key="4"]',
        101: '#pin_table button[key="5"]',
        102: '#pin_table button[key="6"]',
        103: '#pin_table button[key="7"]',
        104: '#pin_table button[key="8"]',
        105: '#pin_table button[key="9"]'
    });
}

function pinAdd(el) {
    let e = document.querySelector('#pin');
    e.value += el.getAttribute('key');
}

window.pinAdd = pinAdd;

function pinBackspace() {
    let e = document.querySelector('#pin');
    e.value = e.value.slice(0, -1);
}

window.pinBackspace = pinBackspace;

function pinEnter() {
    let pin = document.querySelector('#pin').value;
    document.querySelector('#pin').value = '';
    document.querySelector('#pin_dialog').callback(null, pin);
    showAlert(global.alert);

    window.removeEventListener('keydown', pinKeydownHandler);
}

window.pinEnter = pinEnter;

/*
 * passphrase
 */

function emptyPassphraseCallback(callback) {
    callback(null, '');
}

function passphraseCallback(callback) {
    document.querySelector('#passphrase_dialog').callback = callback;
    document.querySelector('#passphrase').focus();
    window.addEventListener('keydown', passphraseKeydownHandler);
    showAlert('#passphrase_dialog');
}

function passphraseKeydownHandler(ev) {
    clickMatchingElement(ev, {
        13: '#passphrase_enter button'
    });
}

function passphraseToggle() {
    let e = document.querySelector('#passphrase');
    e.type = (e.type === 'text') ? 'password' : 'text';
}

window.passphraseToggle = passphraseToggle;

function passphraseEnter() {
    let passphrase = document.querySelector('#passphrase').value;
    window.removeEventListener('keydown', passphraseKeydownHandler);
    document.querySelector('#passphrase_dialog').callback(null, passphrase);
    showAlert(global.alert);
}

window.passphraseEnter = passphraseEnter;

/*
 * utils
 */

// taken from https://github.com/substack/semver-compare/blob/master/index.js
function semvercmp(a, b) {
    let pa = a.split('.');
    let pb = b.split('.');
    for (let i = 0; i < 3; i++) {
        let na = Number(pa[i]);
        let nb = Number(pb[i]);
        if (na > nb) return 1;
        if (nb > na) return -1;
        if (!isNaN(na) && isNaN(nb)) return 1;
        if (isNaN(na) && !isNaN(nb)) return -1;
    }
    return 0;
}

function clickMatchingElement(ev, keys, active = 'active') {
    let s = keys[ev.keyCode.toString()];
    if (s) {
        let e = document.querySelector(s);
        if (e) {
            e.click();
            e.classList.add(active);
            setTimeout(() => {
                e.classList.remove(active);
            }, 25);
        }
    }
}

function show(selector) {
    let els = document.querySelectorAll(selector);
    for (let i = 0; i < els.length; i++) {
        els[i].style.display = '';
    }
    return els;
}

function showAlert(element) {
    fadeOut('.alert');
    fadeIn(element);
}

function fadeIn(selector) {
    let els = document.querySelectorAll(selector);
    for (let i = 0; i < els.length; i++) {
        els[i].classList.remove('fadeout');
    }
    return els;
}

function fadeOut(selector) {
    let els = document.querySelectorAll(selector);
    for (let i = 0; i < els.length; i++) {
        els[i].classList.add('fadeout');
    }
    return els;
}

function resolveAfter(msec, value) {
    return new Promise((resolve) => {
        setTimeout(resolve, msec, value);
    });
}

function closeWindow() {
    setTimeout(() => { window.close(); }, 50);
}

window.closeWindow = closeWindow;