import { baseDecode, baseEncode } from 'borsh';

import {
  AddressValidation,
  SignedTx,
  UnsignedTx,
} from '../../../types/provider';
import { Signer, Verifier } from '../../../types/secret';
import { BaseProvider } from '../../abc';

import { NearCli } from './nearcli';
import { PublicKey } from './sdk/key_pair';
import * as nearTx from './sdk/transaction';

const FT_TRANSFER_GAS = '30000000000000';
const FT_TRANSFER_DEPOSIT = '1';

const IMPLICIT_ACCOUNT_PATTERN = /^[a-z\d]{64}$/;
const REGISTER_ACCOUNT_PATTERN =
  /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/;

const packActions = (unsignedTx: UnsignedTx) => {
  const { inputs, outputs } = unsignedTx;
  const [output] = outputs;
  const actions = [];

  if (!output.tokenAddress) {
    actions.push(nearTx.transfer(output.value.integerValue().toFixed()));
  } else {
    actions.push(
      nearTx.functionCall(
        'ft_transfer',
        {
          amount: output.value.integerValue().toFixed(),
          receiver_id: output.address,
        },
        FT_TRANSFER_GAS,
        FT_TRANSFER_DEPOSIT,
      ),
    );
  }

  return actions;
};

class Provider extends BaseProvider {
  get nearCli(): Promise<NearCli> {
    return this.clientSelector((i) => i instanceof NearCli);
  }

  async pubkeyToAddress(
    verifier: Verifier,
    encoding?: string,
  ): Promise<string> {
    const pubkey = await verifier.getPubkey(true);
    if (encoding === 'ENCODED_PUBKEY') {
      return 'ed25519:' + baseEncode(pubkey);
    } else {
      return pubkey.toString('hex');
    }
  }

  async verifyAddress(address: string): Promise<AddressValidation> {
    let encoding: string | undefined = undefined;
    if (IMPLICIT_ACCOUNT_PATTERN.test(address)) {
      encoding = 'IMPLICIT_ACCOUNT';
    } else if (REGISTER_ACCOUNT_PATTERN.test(address)) {
      return {
        isValid: true,
        normalizedAddress: address,
        displayAddress: address,
        encoding: 'REGISTER_ACCOUNT',
      };
    } else if (address.includes(':')) {
      const [prefix, encoded] = address.split(':');
      try {
        if (
          prefix === 'ed25519' &&
          Buffer.from(baseDecode(encoded)).length === 32
        ) {
          encoding = 'ENCODED_PUBKEY';
        }
      } catch (e) {
        // ignored
      }
    }

    if (encoding) {
      return {
        isValid: true,
        normalizedAddress: address,
        displayAddress: address,
        encoding,
      };
    } else {
      return {
        isValid: false,
      };
    }
  }

  async buildUnsignedTx(unsignedTx: UnsignedTx): Promise<UnsignedTx> {
    const cli = await this.nearCli;
    const {
      inputs: [input],
      payload = {},
    } = unsignedTx;
    let { nonce } = unsignedTx;

    const feePricePerUnit =
      unsignedTx.feePricePerUnit ||
      (await cli.getFeePricePerUnit().then((i) => i.normal.price));

    if (input) {
      nonce =
        nonce ?? (await cli.getAddress(input.address).then((i) => i.nonce));

      const { blockHash } = await cli.getBestBlock();
      Object.assign(payload, { blockHash });
    }

    return Object.assign({}, unsignedTx, {
      feePricePerUnit,
      nonce,
      payload,
    });
  }

  async signTransaction(
    unsignedTx: UnsignedTx,
    signers: { [p: string]: Signer },
  ): Promise<SignedTx> {
    const {
      inputs: [input],
      outputs: [output],
      nonce,
      payload: { blockHash },
    } = unsignedTx;
    const signer = signers[input.address];
    const pubkey = await signer.getPubkey(true);

    const actions = packActions(unsignedTx);
    const tx = nearTx.createTransaction(
      input.address,
      PublicKey.from(new Uint8Array(pubkey)),
      output.tokenAddress || output.address,
      nonce!,
      actions,
      baseDecode(blockHash),
    );
    const [hash, signedTx] = await nearTx.signTransactionObject(tx, (digest) =>
      signer.sign(Buffer.from(digest)).then((res) => new Uint8Array(res[0])),
    );

    return {
      txid: baseEncode(hash),
      rawTx: Buffer.from(signedTx.encode()).toString('base64'),
    };
  }
}

export { Provider };
