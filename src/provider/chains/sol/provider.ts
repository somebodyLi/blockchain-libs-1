import * as splToken from '@solana/spl-token';
import { PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import BigNumber from 'bignumber.js';
import bs58 from 'bs58';

import { check } from '../../../basic/precondtion';
import { HardwareSigner } from '../../../types/hardware';
import {
  AddressValidation,
  SignedTx,
  UnsignedTx,
} from '../../../types/provider';
import { Signer, Verifier } from '../../../types/secret';
import { BaseProvider, isHardwareSigner } from '../../abc';

import { Solana } from './solana';
class Provider extends BaseProvider {
  get solana(): Promise<Solana> {
    return this.clientSelector((i) => i instanceof Solana);
  }
  async buildUnsignedTx(unsignedTx: UnsignedTx): Promise<UnsignedTx> {
    const feePricePerUnit = unsignedTx.feePricePerUnit
      ? unsignedTx.feePricePerUnit
      : (await (await this.solana).getFeePricePerUnit()).normal.price;
    const txInput = unsignedTx.inputs[0];
    const txOutput = unsignedTx.outputs[0];
    const payload = unsignedTx.payload || {};
    const feeLimit = new BigNumber(1); // len(transfer_tx.signatures)
    if (txInput && txOutput) {
      const tokenAddress = txInput.tokenAddress;
      const receiver = txOutput.address;
      // Note: method `is_on_curve` may has risk. see https://github.com/solana-labs/solana/issues/17106
      const isValidSystemAccount = PublicKey.isOnCurve(bs58.decode(receiver));
      // spl-token transfer
      if (tokenAddress) {
        payload.isTokenAccount = false;
        const accountInfo = await (await this.solana).getAccountInfo(receiver);
        // account not funded: only support system account
        if (accountInfo === null) {
          check(isValidSystemAccount, 'only not_funded system account allowed');
        } else {
          if (isValidSystemAccount) {
            check(
              accountInfo.owner == SystemProgram.programId.toString(),
              `system account with invalid owner ${accountInfo.owner}`,
            );
          } else {
            // token account
            check(
              accountInfo.owner == splToken.TOKEN_PROGRAM_ID.toString(),
              'invalid account owner',
            );
            check(
              accountInfo.data.parsed.info.mint == tokenAddress,
              `invalid token account with ${tokenAddress}`,
            );
            payload.accountFunded = true;
            payload.isTokenAccount = true;
          }
        }
        if (isValidSystemAccount) {
          const tokenReceiver = await this.getAssociatedTokenAddress(
            new PublicKey(receiver),
            new PublicKey(tokenAddress),
          );
          const accountInfo = await (
            await this.solana
          ).getAccountInfo(tokenReceiver.toString());
          if (accountInfo === null) {
            payload.accountFunded = false;
          } else {
            payload.accountFunded = true;
          }
        }
      } else {
        // sol transfer only support system accounts
        check(isValidSystemAccount, 'fall off curve pubkey is not allowed');
      }
      // something like nonce
      const [_, recentBlockhash] = await (await this.solana).getFees();
      payload.recentBlockhash = recentBlockhash;
    }
    return {
      inputs: txInput ? [txInput] : [],
      outputs: txOutput ? [txOutput] : [],
      feeLimit,
      feePricePerUnit,
      payload,
    };
  }

  async pubkeyToAddress(
    verifier: Verifier,
    encoding?: string,
  ): Promise<string> {
    const pubkeyBytes = await verifier.getPubkey();
    const address = new PublicKey(pubkeyBytes).toBase58();
    return address;
  }

  async signTransaction(
    unsignedTx: UnsignedTx,
    signers: { [p: string]: Signer } | HardwareSigner,
  ): Promise<SignedTx> {
    const sender = unsignedTx.inputs[0].address;
    const receiver = unsignedTx.outputs[0].address;
    const amount = unsignedTx.outputs[0].value;
    const tokenAddress = unsignedTx.outputs[0].tokenAddress;
    const transferTx = await this.buildTx(
      sender,
      receiver,
      amount,
      unsignedTx.payload,
      tokenAddress,
    );
    const signData = transferTx.serializeMessage();
    let sig;
    if (isHardwareSigner(signers)) {
      [sig] = await signers.hardwareSign(signData);
    } else {
      [sig] = await signers[sender].sign(signData);
    }
    check(sig.length === 64, 'signature has invalid length');
    transferTx.addSignature(new PublicKey(sender), sig);
    const txid = bs58.encode(sig);
    const rawTx = transferTx.serialize().toString('base64');
    return { txid, rawTx };
  }
  private async getAssociatedTokenAddress(
    owner: PublicKey,
    mint: PublicKey,
  ): Promise<PublicKey> {
    const associatedTokenAddress =
      await splToken.Token.getAssociatedTokenAddress(
        splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
        splToken.TOKEN_PROGRAM_ID,
        mint,
        owner,
      );
    return associatedTokenAddress;
  }
  private async buildTx(
    fromAddr: string,
    toAddr: string,
    amount: BigNumber,
    payload: { [key: string]: any },
    mintAddress?: string,
  ): Promise<Transaction> {
    const transferTx = new Transaction();
    const sender = new PublicKey(fromAddr);
    transferTx.feePayer = sender;
    const receiver = new PublicKey(toAddr);
    if (mintAddress) {
      // SPL-Token transfer
      const tokenSender = await this.getAssociatedTokenAddress(
        sender,
        new PublicKey(mintAddress),
      );
      const accountFunded: boolean = payload.accountFunded;
      const isTokenAccount: boolean = payload.isTokenAccount;
      const tokenReceiver = isTokenAccount
        ? receiver
        : await this.getAssociatedTokenAddress(
            receiver,
            new PublicKey(mintAddress),
          );
      // account not funded means system account
      if (!accountFunded) {
        transferTx.add(
          splToken.Token.createAssociatedTokenAccountInstruction(
            splToken.ASSOCIATED_TOKEN_PROGRAM_ID,
            splToken.TOKEN_PROGRAM_ID,
            new PublicKey(mintAddress),
            tokenReceiver,
            receiver,
            sender,
          ),
        );
      }
      transferTx.add(
        splToken.Token.createTransferInstruction(
          splToken.TOKEN_PROGRAM_ID,
          tokenSender,
          tokenReceiver,
          sender,
          [],
          amount.toNumber(),
        ),
      );
    } else {
      // SOL transfer
      transferTx.add(
        SystemProgram.transfer({
          fromPubkey: sender,
          toPubkey: receiver,
          lamports: amount.toNumber(),
        }),
      );
    }

    transferTx.recentBlockhash = payload.recentBlockhash;
    return transferTx;
  }

  async verifyAddress(address: string): Promise<AddressValidation> {
    let isValid = true;
    try {
      new PublicKey(address);
    } catch (error) {
      isValid = false;
    }
    return {
      normalizedAddress: isValid ? address : undefined,
      displayAddress: isValid ? address : undefined,
      isValid,
    };
  }
  /***
   * Note: this method is used to verify associatedTokenAddress instead of mintAddress(if mintAddress use verifyAddress or getTokenInfos instead)
   *
   */
  async verifyTokenAddress(address: string): Promise<AddressValidation> {
    const result = await this.verifyAddress(address);
    if (result.isValid) {
      const isOnCurve = PublicKey.isOnCurve(bs58.decode(address));
      // validate program address is off ed25519 curve
      result.isValid = !isOnCurve;
    }
    return result;
  }
}

export { Provider };
