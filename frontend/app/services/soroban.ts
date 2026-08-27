"use client";

import {
  Contract,
  rpc,
  TransactionBuilder,
  Networks,
  BASE_FEE,
  Address,
  nativeToScVal,
  scValToNative,
  xdr,
} from "@stellar/stellar-sdk";
import { signTransaction } from "@stellar/freighter-api";

// Environment configuration
export const SOROBAN_CONFIG = {
  RPC_URL: process.env.NEXT_PUBLIC_SOROBAN_RPC_URL || "https://soroban-testnet.stellar.org",
  NETWORK_PASSPHRASE: process.env.NEXT_PUBLIC_STELLAR_NETWORK === "MAINNET"
    ? Networks.PUBLIC
    : Networks.TESTNET,
  CONTRACT_ID: process.env.NEXT_PUBLIC_VYC_CONTRACT_ID || "",
};

export interface MintVycParams {
  adminAddress: string;
  farmerAddress: string;
  score: number;
  expectedYield: string; // in micro-USDC
  crop: string;
  region: string;
  activityHash: string;
}

export interface VycRecord {
  id: string;
  farmer: string;
  score: number;
  expectedYield: string;
  crop: string;
  region: string;
  activityHash: string;
  status: "Active" | "Redeemed" | "Expired" | "Cancelled";
  createdAt: number;
  updatedAt: number;
}

export interface MintResult {
  success: boolean;
  vycId?: string;
  txHash?: string;
  error?: string;
}

export interface QueryResult {
  success: boolean;
  data?: VycRecord;
  error?: string;
}

/**
 * Initialize the Soroban RPC server
 */
export function getSorobanServer(): rpc.Server {
  return new rpc.Server(SOROBAN_CONFIG.RPC_URL, {
    allowHttp: SOROBAN_CONFIG.RPC_URL.startsWith("http://"),
  });
}

/**
 * Build and prepare a contract call transaction
 */
async function buildTransaction(
  publicKey: string,
  contractId: string,
  method: string,
  params: xdr.ScVal[]
): Promise<ReturnType<rpc.Server["prepareTransaction"]>> {
  const server = getSorobanServer();
  const sourceAccount = await server.getAccount(publicKey);

  const contract = new Contract(contractId);

  const transaction = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: SOROBAN_CONFIG.NETWORK_PASSPHRASE,
  })
    .addOperation(contract.call(method, ...params))
    .setTimeout(300)
    .build();

  return await server.prepareTransaction(transaction);
}

/**
 * Mint a new Verifiable Yield Certificate
 * This function requires admin authorization
 */
export async function mintVyc(params: MintVycParams): Promise<MintResult> {
  try {
    const {
      adminAddress,
      farmerAddress,
      score,
      expectedYield,
      crop,
      region,
      activityHash,
    } = params;

    // Validate inputs
    if (!adminAddress || !farmerAddress) {
      return { success: false, error: "Invalid addresses" };
    }

    if (score < 0 || score > 100) {
      return { success: false, error: "Score must be between 0 and 100" };
    }

    if (!expectedYield || BigInt(expectedYield) <= 0) {
      return { success: false, error: "Expected yield must be positive" };
    }

    if (!crop || !region || !activityHash) {
      return { success: false, error: "Missing required fields" };
    }

    // Build the transaction parameters
    // Convert expectedYield string to BigInt for i128 type
    const yieldBigInt = BigInt(expectedYield);

    // Soroban symbols cannot contain hyphens, convert to underscores
    const regionSymbol = region.replace(/-/g, "_");

    const contractParams = [
      new Address(adminAddress).toScVal(), // admin
      new Address(farmerAddress).toScVal(), // farmer
      nativeToScVal(score, { type: "u32" }), // score
      nativeToScVal(yieldBigInt, { type: "i128" }), // expected_yield
      nativeToScVal(crop, { type: "symbol" }), // crop
      nativeToScVal(regionSymbol, { type: "symbol" }), // region
      nativeToScVal(activityHash, { type: "string" }), // activity_hash
    ];

    // Build and prepare the transaction
    const preparedTx = await buildTransaction(
      adminAddress,
      SOROBAN_CONFIG.CONTRACT_ID,
      "mint_vyc",
      contractParams
    );

    // Sign the transaction using Freighter
    const signedXdr = await signTransaction(preparedTx.toXDR(), {
      networkPassphrase: SOROBAN_CONFIG.NETWORK_PASSPHRASE,
      accountToSign: adminAddress,
    });

    // Submit the transaction
    const server = getSorobanServer();
    const tx = TransactionBuilder.fromXDR(signedXdr, SOROBAN_CONFIG.NETWORK_PASSPHRASE);

    const sendResponse = await server.sendTransaction(tx);

    // Poll for the result
    if (sendResponse.status === "PENDING") {
      let getResponse = await server.getTransaction(sendResponse.hash);

      // Poll every 1 second for up to 30 seconds
      const maxAttempts = 30;
      let attempts = 0;

      while (getResponse.status === rpc.Api.GetTransactionStatus.NOT_FOUND && attempts < maxAttempts) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        getResponse = await server.getTransaction(sendResponse.hash);
        attempts++;
      }

      if (getResponse.status === rpc.Api.GetTransactionStatus.SUCCESS) {
        // mint_vyc now returns Result<u64, MintError>. Soroban serializes a
        // Result as a two-element vector ["Ok", id] | ["Err", error], so the
        // bare scValToNative(...).toString() of the old u64 path would yield
        // garbage like "Ok,5". Unwrap the Result explicitly.
        const decoded = scValToNative(getResponse.returnValue!);

        if (Array.isArray(decoded) && decoded[0] === "Ok") {
          return {
            success: true,
            vycId: String(decoded[1]),
            txHash: sendResponse.hash,
          };
        }

        if (Array.isArray(decoded) && decoded[0] === "Err") {
          return {
            success: false,
            error: `Mint rejected by contract: ${String(decoded[1])}`,
            txHash: sendResponse.hash,
          };
        }

        // Fallback for a bare u64 return (pre-Result contract).
        if (decoded !== undefined && decoded !== null) {
          return {
            success: true,
            vycId: String(decoded),
            txHash: sendResponse.hash,
          };
        }

        return {
          success: false,
          error: "Contract returned an empty result",
          txHash: sendResponse.hash,
        };
      } else {
        return {
          success: false,
          error: `Transaction failed with status: ${getResponse.status}`,
        };
      }
    }

    return {
      success: false,
      error: "Transaction submission failed",
    };
  } catch (error) {
    console.error("Error minting VYC:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to mint VYC. Please try again.",
    };
  }
}

/**
 * Get a VYC record by ID
 */
export async function getVyc(vycId: string): Promise<QueryResult> {
  try {
    const server = getSorobanServer();

    // Use a dummy account for read-only queries
    const dummyAccount = await server.getAccount(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
    ).catch(() => null);

    if (!dummyAccount) {
      return { success: false, error: "Failed to initialize query" };
    }

    const contract = new Contract(SOROBAN_CONFIG.CONTRACT_ID);
    const params = [nativeToScVal(vycId, { type: "u64" })];

    const transaction = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: SOROBAN_CONFIG.NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("get_vyc", ...params))
      .setTimeout(300)
      .build();

    const simResponse = await server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationSuccess(simResponse) && simResponse.result) {
      const resultVal = simResponse.result.retval;
      const vycData = scValToNative(resultVal);

      // Map status enum
      const statusMap: Record<number, "Active" | "Redeemed" | "Expired" | "Cancelled"> = {
        0: "Active",
        1: "Redeemed",
        2: "Expired",
        3: "Cancelled",
      };

      const vyc: VycRecord = {
        id: vycData.id.toString(),
        farmer: vycData.farmer,
        score: vycData.score,
        expectedYield: vycData.expected_yield.toString(),
        crop: vycData.crop,
        region: vycData.region,
        activityHash: vycData.activity_hash,
        status: statusMap[vycData.status] || "Active",
        createdAt: vycData.created_at,
        updatedAt: vycData.updated_at,
      };

      return { success: true, data: vyc };
    }

    return { success: false, error: "Failed to query VYC" };
  } catch (error) {
    console.error("Error querying VYC:", error);
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to query VYC",
    };
  }
}

/**
 * Get all VYC IDs for a farmer
 */
export async function getFarmerVycs(farmerAddress: string): Promise<string[]> {
  try {
    const server = getSorobanServer();

    const dummyAccount = await server.getAccount(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
    ).catch(() => null);

    if (!dummyAccount) {
      return [];
    }

    const contract = new Contract(SOROBAN_CONFIG.CONTRACT_ID);
    const params = [new Address(farmerAddress).toScVal()];

    const transaction = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: SOROBAN_CONFIG.NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("get_farmer_vycs", ...params))
      .setTimeout(300)
      .build();

    const simResponse = await server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationSuccess(simResponse) && simResponse.result) {
      const resultVal = simResponse.result.retval;
      const vycIds = scValToNative(resultVal);
      return vycIds.map((id: bigint) => id.toString());
    }

    return [];
  } catch (error) {
    console.error("Error querying farmer VYCs:", error);
    return [];
  }
}

/**
 * Get the total number of VYCs minted
 */
export async function getVycCount(): Promise<number> {
  try {
    const server = getSorobanServer();

    const dummyAccount = await server.getAccount(
      "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
    ).catch(() => null);

    if (!dummyAccount) {
      return 0;
    }

    const contract = new Contract(SOROBAN_CONFIG.CONTRACT_ID);

    const transaction = new TransactionBuilder(dummyAccount, {
      fee: BASE_FEE,
      networkPassphrase: SOROBAN_CONFIG.NETWORK_PASSPHRASE,
    })
      .addOperation(contract.call("get_vyc_count"))
      .setTimeout(300)
      .build();

    const simResponse = await server.simulateTransaction(transaction);

    if (rpc.Api.isSimulationSuccess(simResponse) && simResponse.result) {
      const resultVal = simResponse.result.retval;
      return Number(scValToNative(resultVal));
    }

    return 0;
  } catch (error) {
    console.error("Error querying VYC count:", error);
    return 0;
  }
}
