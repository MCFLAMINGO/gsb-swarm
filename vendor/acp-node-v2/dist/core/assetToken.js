import { parseUnits } from "viem";
import { USDC_ADDRESSES, USDC_DECIMALS, USDC_SYMBOL, getAddressForChain } from "./constants.js";
export class AssetToken {
    constructor(address, symbol, decimals, amount) {
        this.address = address;
        this.symbol = symbol;
        this.decimals = decimals;
        this.amount = amount;
        this.rawAmount = parseUnits(amount.toString(), decimals);
    }
    static create(address, symbol, decimals, amount) {
        return new AssetToken(address, symbol, decimals, amount);
    }
    static usdc(amount, chainId) {
        const address = getAddressForChain(USDC_ADDRESSES, chainId, "USDC");
        const decimals = USDC_DECIMALS[chainId];
        if (decimals === undefined)
            throw new Error(`No USDC decimals configured for chainId ${chainId}`);
        return new AssetToken(address, USDC_SYMBOL, decimals, amount);
    }
    static usdcFromRaw(rawAmount, chainId) {
        const address = getAddressForChain(USDC_ADDRESSES, chainId, "USDC");
        const decimals = USDC_DECIMALS[chainId];
        if (decimals === undefined)
            throw new Error(`No USDC decimals configured for chainId ${chainId}`);
        const dec = Number(rawAmount) / 10 ** decimals;
        return new AssetToken(address, USDC_SYMBOL, decimals, dec);
    }
    static async fromOnChain(address, amount, chainId, client) {
        if (address === USDC_ADDRESSES[chainId]) {
            return AssetToken.usdc(amount, chainId);
        }
        const [decimals, symbol] = await Promise.all([
            client.getTokenDecimals(chainId, address),
            client.getTokenSymbol(chainId, address),
        ]);
        return new AssetToken(address, symbol, decimals, amount);
    }
    static async fromOnChainRaw(address, rawAmount, chainId, client) {
        if (address === USDC_ADDRESSES[chainId]) {
            return AssetToken.usdcFromRaw(rawAmount, chainId);
        }
        const [decimals, symbol] = await Promise.all([
            client.getTokenDecimals(chainId, address),
            client.getTokenSymbol(chainId, address),
        ]);
        return new AssetToken(address, symbol, decimals, Number(rawAmount) / 10 ** decimals);
    }
}
//# sourceMappingURL=assetToken.js.map