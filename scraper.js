const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const axios = require('axios');

// ================= სისტემის პარამეტრები ================= 
const RECEIVER_URL = "https://masala.com.ge/pharmacy_receiver.php"; // შეცვალეთ საჭიროებისამებრ
const SECRET_TOKEN = "MY_SUPER_SECRET_12345";
const FAILSAFE_LIMIT = 100; // რამდენი გვერდი დაასკანეროს მაქსიმუმ

const AUTOWINI_BASE_URL = 'https://www.autowini.com/search/items?itemType=cars&condition=C020';
// =======================================================

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            let distance = 500;
            let timer = setInterval(() => {
                let scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 150);
        });
    });
}

/**
 * მონაცემების გაგზავნა მიმღებთან
 */
async function sendBatch(id, name, productsArray) {
    if (!productsArray || productsArray.length === 0) return;
    try {
        const payload = new URLSearchParams();
        payload.append('token', SECRET_TOKEN);
        payload.append('pharmacy_id', id); // აქ ავტომობილების შემთხვევაში შეგიძლიათ სხვა ID გამოიყენოთ
        payload.append('products', JSON.stringify(productsArray));

        console.log(`📡 [${name}] აგზავნის ${productsArray.length} ავტომობილს...`);
        const response = await axios.post(RECEIVER_URL, payload);
        console.log(`✅ [${name} DB]:`, response.data);
        productsArray.length = 0;
    } catch (error) {
        console.error(`❌ [${name} გაგზავნის შეცდომა]:`, error.message);
    }
}

(async () => {
    let browser = null;
    try {
        console.log(">> 🚀 [სისტემა] ვიწყებთ Autowini-ს სკრაპინგს...");
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });

        let carBatch = [];

        for (let i = 1; i <= FAILSAFE_LIMIT; i++) {
            // Autowini პაგინაცია იყენებს pageOffset= გვერდის ნომერს
            let currentUrl = (i === 1) ? AUTOWINI_BASE_URL : `${AUTOWINI_BASE_URL}&pageOffset=${i}`;
            
            console.log(`\n-> [Autowini] გვერდი: ${i} | URL: ${currentUrl}`);
            
            try {
                await page.goto(currentUrl, { waitUntil: 'networkidle2', timeout: 60000 });
                await autoScroll(page);
                await sleep(2000);

                const extracted = await page.evaluate(() => {
                    let items = [];
                    // ვეძებთ მთავარ კარტებს (a თეგებს რომლებსაც აქვთ /items/ ლინკი)
                    const cards = document.querySelectorAll('a[href*="/items/"]');

                    cards.forEach(card => {
                        // სახელის სელექტორი h3.css-17a81cf მიხედვით
                        let nameEl = card.querySelector('h3.css-17a81cf') || card.querySelector('h3');
                        
                        // ფასი მოცემულია <exchanged-price price="3,993"> ში
                        let priceEl = card.querySelector('exchanged-price');
                        
                        // სურათი
                        let imgEl = card.querySelector('img.css-k7hb9y') || card.querySelector('img');
                        
                        // დეტალები (წელი, ძრავი, გარბენი)
                        let detailEl = card.querySelector('.css-tdwsr p');

                        if (nameEl && priceEl) {
                            let name = nameEl.innerText.trim();
                            // ვიღებთ price ატრიბუტს, ვაშორებთ მძიმეს და ვაქცევთ რიცხვად
                            let rawPrice = priceEl.getAttribute('price') || "0";
                            let price = parseFloat(rawPrice.replace(/,/g, ''));
                            let image = imgEl ? imgEl.src : '';
                            let info = detailEl ? detailEl.innerText.trim() : '';

                            if (price > 0) {
                                items.push({
                                    name: name + (info ? " - " + info : ""),
                                    price: price,
                                    image_url: image
                                });
                            }
                        }
                    });
                    return items;
                });

                if (extracted.length === 0) {
                    console.log("🔸 მონაცემები ვეღარ მოიძებნა. სკანირება დასრულებულია.");
                    break;
                }

                console.log(`✅ გვერდზე ნაპოვნია ${extracted.length} ავტომობილი.`);
                carBatch.push(...extracted);

                // ვაგზავნით ყოველი გვერდის მერე
                await sendBatch(100, "Autowini_Cars", carBatch);

            } catch (pageErr) {
                console.error(`❌ შეცდომა ${i} გვერდზე:`, pageErr.message);
                continue; 
            }
        }

    } catch (criticalErr) {
        console.error("\n[კრიტიკული შეცდომა] ->", criticalErr);
    } finally {
        if (browser !== null) {
            console.log("\n>> 🏁 სამუშაო დასრულდა. ბრაუზერი იხურება.");
            await browser.close();
        }
    }
})();