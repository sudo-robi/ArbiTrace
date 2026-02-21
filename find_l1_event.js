import { ethers } from 'ethers';
const rpc = 'https://eth-sepolia.g.alchemy.com/v2/8IoY3ucoqA7zi3qRg7yi4';
const p = new ethers.JsonRpcProvider(rpc);
const inbox = ethers.getAddress('0xaae26d971249704f5353163351c1a221f20aae21');
const topic = '0xc4ead0e389ccdf68bf81807c89f6820029b15cb9f3d1e0e5b176bf0ceaa74b50';

async function find() {
    try {
        const center = 10300375;
        console.log('Scanning Inbox logs around', center);

        const startRange = center - 100;
        const endRange = center + 100;

        for (let current = startRange; current < endRange; current += 10) {
            const end = current + 9;
            console.log(`Scanning [${current}, ${end}] for address ${inbox}...`);
            try {
                const logs = await p.getLogs({
                    address: inbox,
                    fromBlock: current,
                    toBlock: end,
                    topics: [topic]
                });
                if (logs.length > 0) {
                    console.log(`Found ${logs.length} logs in chunk [${current}, ${end}]`);
                    logs.forEach(l => {
                        console.log(`  Tx: ${l.transactionHash}`);
                        console.log(`  TicketId: ${l.topics[1]}`);
                    });
                }
            } catch (e) {
                console.warn(`Chunk [${current}, ${end}] failed: ${e.message}`);
            }
        }
    } catch (e) {
        console.error(e);
    }
}
find();
