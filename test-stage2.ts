import { AuctionParser } from './src/modules/auction/auction-parser';
import { NumericDecoder } from './src/modules/auction/numeric-decoder';

async function test() {
    const decoder = new NumericDecoder();
    const parser = new AuctionParser(decoder);
    
    console.log("--- TEST 1: Lot vs Fee Discrimination ---");
    // Scenario: Block starts with noise, then a real car name, then a fee that looks like a lot number.
    const block1 = [
        "1550",           // Common Fee, but at index 0 (might be Lot?)
        "RAIZE Z",
        "A202A-0147410",
        "03/31",          // Standalone date
        "1550",           // This same number appears later - should be the Fee
        "90003045000"     // Billion-yen packed price
    ];
    const res1 = parser.parseBlock(block1);
    console.log(`Lot: ${res1.lotNumber}, Fee: ${res1.auctionFee}, Car: ${res1.carName}, Date: ${res1.date}`);
    console.log(`Prices: Bid=${res1.startingPrice}, Total=${res1.finalPrice}, Recycle=${res1.recycle}`);
    console.log(`Flags: ${res1.flags.join(', ')}`);

    console.log("\n--- TEST 2: Billion-Yen Splitting ---");
    const res2 = decoder.decode("95503045000", null, null);
    console.log(JSON.stringify(res2, null, 2));
}
test();
