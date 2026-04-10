import { EvmAcpClient } from "./clients/evmAcpClient";
import { SolanaAcpClient } from "./clients/solanaAcpClient";
import type { IProviderAdapter } from "./providers/types";
export type AcpClient = EvmAcpClient | SolanaAcpClient;
export type CreateAcpClientInput = {
    contractAddresses?: Record<number, string>;
    provider: IProviderAdapter;
};
export declare function createAcpClient(input: CreateAcpClientInput): Promise<AcpClient>;
//# sourceMappingURL=clientFactory.d.ts.map