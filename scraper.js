const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const axios = require('axios');

// ================= სისტემის პარამეტრები ================= 
const RECEIVER_URL = "https://masala.com.ge/pharmacy_receiver.php";
const SECRET_TOKEN = "MY_SUPER_SECRET_12345";
const START_PAGE = 1;
const MAX_PAGES = 50; 

const sleep = ms => new Promise(res => setTimeout(res, ms));

/**
 * მონაცემების გაგზავნა ბაზაში
 */
async function sendBatch(dataArray) {
    if (dataArray.length === 0) return;
    try {
        console.log(`📡 ბაზაში იგზავნება ${dataArray.length} მანქანის დეტალური ინფო...`);
        const payload = new URLSearchParams();
        payload.append('token', SECRET_TOKEN);
        payload.append('data', JSON.stringify(dataArray));
        
        // რეალური გაგზავნისთვის (წაშალეთ კომენტარი):
        await axios.post(RECEIVER_URL, payload);
        
        console.log(`   ✅ წარმატებით გაიგზავნა.`);
        dataArray.length = 0; // მასივის გასუფთავება RAM-ისთვის
    } catch (error) {
        console.error(`   ❌ გაგზავნის შეცდომა:`, error.message);
    }
}

/**
 * კონკრეტული მანქანის გვერდიდან ინფორმაციის ამოღება
 */
async function scrapeCarDetail(page, url) {
    try {
        console.log(`   🔍 შევდივარ: ${url}`);
        // ვიყენებთ domcontentloaded-ს დროის დასაზოგად და შემდეგ ვაცდით 2 წამს
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
        await sleep(3000);

        const data = await page.evaluate(() => {
            const results = {};
            
            // 1. ფოტოების ამოღება (Thumbnail-ებიდან იღებს ორიგინალს)
            const photoElements = Array.from(document.querySelectorAll('.thumb-list img, .photo-list img, [data-original]'));
            results.photos = photoElements
                .map(img => img.getAttribute('data-original') || img.getAttribute('src'))
                .filter(u => u && u.startsWith('http'))
                .map(u => u.replace('_T.jpg', '_O.jpg')); // ვცდილობთ ორიგინალის (Large) ამოღებას

            // დუბლიკატების წაშლა ფოტოებიდან
            results.photos = [...new Set(results.photos)];

            // 2. სათაური და ფასი
            results.title = document.querySelector('h1')?.innerText.trim() || "";
            results.price = document.querySelector('.price, .itemPrice, .total strong')?.innerText.trim() || "";

            // 3. Basic Information
            results.basicInfo = {};
            document.querySelectorAll('.infoTbl li dl, .spec-list dl').forEach(dl => {
                const key = dl.querySelector('dt')?.innerText.trim().replace(':', '');
                const val = dl.querySelector('dd')?.innerText.trim();
                if (key) results.basicInfo[key] = val;
            });

            // 4. Featured Information
            results.featuredInfo = {};
            document.querySelectorAll('.featureInfo li, .tech-info li').forEach(li => {
                const key = li.querySelector('span')?.innerText.trim();
                const val = li.querySelector('b, strong')?.innerText.trim();
                if (key) results.featuredInfo[key] = val;
            });

            // 5. Options (კომფორტი)
            results.options = {};
            document.querySelectorAll('.optionInfo ul li, .options-area ul li').forEach(li => {
                const category = li.querySelector('h3, h2, strong')?.innerText.trim() || "General";
                const list = Array.from(li.querySelectorAll('.list span, span')).map(s => s.innerText.trim());
                if (list.length > 0) results.options[category] = list;
            });

            // 6. Condition Report
            results.conditionReport = {};
            document.querySelectorAll('.statusArea, .condition-section').forEach(area => {
                const groupTitle = area.querySelector('strong, h3')?.innerText.trim() || "Condition";
                const items = {};
                area.querySelectorAll('li, tr').forEach(li => {
                    const k = li.querySelector('dt, th')?.innerText.trim();
                    const v = li.querySelector('dd, td')?.innerText.trim();
                    if (k) items[k] = v;
                });
                results.conditionReport[groupTitle] = items;
            });

            return results;
        });

        console.log(`      ✅ ამოღებულია: ${data.title} (${data.photos.length} ფოტო)`);
        return { ...data, url, scrapedAt: new Date().toISOString() };

    } catch (e) {
        console.error(`      ⚠️ შეცდომა ${url}-ზე: ${e.message}`);
        return null;
    }
}

/**
 * მთავარი ფუნქცია
 */
(async () => {
    console.log("🚀 სკრაპერი ჩაირთო...");

    const browser = await puppeteer.launch({
    headless: "new",
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu'
    ]
});

    try {
        const mainPage = await browser.newPage();
        const detailPage = await browser.newPage();
        
        await mainPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');
        await detailPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36');

        let allBatchData = [];

        for (let p = START_PAGE; p <= MAX_PAGES; p++) {
            const listUrl = `https://www.autowini.com/search/items?itemType=cars&condition=C020&pageOffset=${p}`;
            console.log(`\n📄 მუშავდება გვერდი: ${p}`);
            
            await mainPage.goto(listUrl, { waitUntil: 'networkidle2', timeout: 60000 });

            // ლინკების ამოკრება
            const carLinks = await mainPage.evaluate(() => {
                return Array.from(document.querySelectorAll('a[href*="/items/Used-"]'))
                    .map(a => a.href)
                    .filter((value, index, self) => self.indexOf(value) === index);
            });

            console.log(`🔗 ნაპოვნია ${carLinks.length} მანქანა.`);

            if (carLinks.length === 0) break;

            for (const link of carLinks) {
                const detailData = await scrapeCarDetail(detailPage, link);
                if (detailData && detailData.title) {
                    allBatchData.push(detailData);
                }

                if (allBatchData.length >= 5) {
                    await sendBatch(allBatchData);
                }
                await sleep(2500);
            }
            
            // ნაშთის გაგზავნა გვერდის ბოლოს
            await sendBatch(allBatchData);
        }

    } catch (err) {
        console.error("🛑 კრიტიკული შეცდომა:", err.message);
    } finally {
        await browser.close();
        console.log("🏁 დასრულდა.");
    }
})();
