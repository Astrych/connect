/* @flow */
'use strict';

import AbstractMethod from './AbstractMethod';
import { getCoinInfoByCurrency } from '../../data/CoinInfo';
import { validatePath } from '../../utils/pathUtils';

import BlockBook, { create as createBackend } from '../../backend';
import * as helper from './helpers/signTx';
import {
    validateInputs,
    validateOutputs,
    getReferencedTransactions,
    transformReferencedTransactions
} from './tx';

import type {
    TransactionInput,
    TransactionOutput,
    SignedTx
} from 'flowtype/trezor';

import type {
    BuildTxInput,
    BuildTxOutput
} from 'hd-wallet';

import type { CoinInfo, CoreMessage } from 'flowtype';



type Params = {
    inputs: Array<TransactionInput>;
    hdInputs:Array<BuildTxInput>;
    outputs: Array<any>;
    coinInfo: CoinInfo;
}

export default class SignTransaction extends AbstractMethod {

    params: Params;
    backend: BlockBook;

    constructor(message: CoreMessage) {
        super(message);
        this.requiredPermissions = ['read', 'write'];
        this.requiredFirmware = '1.6.0';
        this.useDevice = true;
        this.useUi = true;
        this.info = 'Sign transaction';

        const payload: any = message.payload;
        if (!payload.hasOwnProperty('inputs')) {
            throw new Error('Parameter "inputs" is missing');
        }

        if (!payload.hasOwnProperty('outputs')) {
            throw new Error('Parameter "outputs" is missing');
        } else {

        }

        let coinInfo: ?CoinInfo;
        if (!payload.hasOwnProperty('coin')) {
            throw new Error('Parameter "coin" is missing');
        } else {
            if (typeof payload.coin === 'string') {
                coinInfo = getCoinInfoByCurrency(payload.coin);
            } else {
                throw new Error('Parameter "coin" has invalid type. String expected.');
            }
        }

        if (!coinInfo) {
            throw new Error('Coin not found');
        }

        const {
            inputs,
            hdInputs
        } = validateInputs(payload.inputs, coinInfo.network);

        const outputs = validateOutputs(payload.outputs, coinInfo.network);

        const total = outputs.reduce((t, r) => t + r.amount, 0);
        if (total <= coinInfo.dustLimit) {
            throw new Error('AMOUNT_TOO_LOW');
        }

        this.params = {
            inputs,
            hdInputs,
            outputs: payload.outputs,
            coinInfo,
        }
    }

    async run(): Promise<any> {
        // initialize backend
        this.backend = await createBackend(this.params.coinInfo);
        const bjsRefTxs = await this.backend.loadTransactions( getReferencedTransactions(this.params.hdInputs) );
        const refTxs = transformReferencedTransactions(bjsRefTxs);

        const resp = await helper.signTx(
            this.device.getCommands().typedCall.bind( this.device.getCommands() ),
            this.params.inputs,
            this.params.outputs,
            refTxs,
            this.params.coinInfo,
        );

        return {
            foo: 1,
            resp
        }
    }
}