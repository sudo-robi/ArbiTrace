import { findTxOnProviders, findParentL1ForL2Tx, getProviders } from './src/arbitrum.js';
import dotenv from 'dotenv';
dotenv.config();

const txHash = '0xf01609706bab826a06d91690a4ec602daabee4aab03e20371de1613508dcfda9';
const networkId = 'sepolia';

async function run() {
    console.log(`Analyzing ${txHash}...`);
    const detection = await findTxOnProviders(txHash, networkId, null);
    console.log('Detection:', JSON.stringify(detection, (k, v) => typeof v === 'bigint' ? v.toString() : v, 2));

    if (detection.l2Receipt && !detection.l1Receipt) {
        console.log('Triggering Backtrace...');
        const parentL1Hash = await findParentL1ForL2Tx(detection.l2Receipt, networkId, null);
        if (parentL1Hash) {
            console.log('Final Parent L1 Hash:', parentL1Hash);
        } else {
            console.log('Backtrace failed to find parent hash');
        }
    } else {
        console.log('Backtrace not triggered: L1 receipt already present or L2 receipt missing');
    }
}

run().catch(console.error);
