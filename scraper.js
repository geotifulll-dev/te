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
        
        // რეალური გაგზავნისთვის მოხსენით კომენტარი:
        // await axios.post(RECEIVER_URL, payload);
        
        dataArray.length = 0; 
    } catch (error) {
        console.error(`❌ გაგზავნის შეცდომა:`, error.message);
    }
}

/**
 * კონკრეტული მანქანის გვერდიდან ინფორმაციის ამოღება
 */
async function scrapeCarDetail(page, url) {
    try {
        console.log(`   🔍 შევდივარ დეტალებზე: ${url}`);
        await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
        
        // მცირე პაუზა დინამიური ელემენტების ჩასატვირთად
        await sleep(2000);

        const data = await page.evaluate(() => {
            const results = {};
            
            // 1. ფოტოების ამოღება (Thumbnail-ების სიაში ეძებს მაღალი ხარისხის ლინკებს)
            results.photos = Array.from(document.querySelectorAll('ul li a[data-original-url]'))
                .map(a => a.getAttribute('data-original-url'))
                .filter(u => u && u.startsWith('http'));

            // 2. სათაური და ფასი
            results.title = document.querySelector('h1')?.innerText.trim() || "";
            results.price = document.querySelector('.price .itemPrice .total strong')?.innerText.trim() || "";

            // 3. Basic Information (ძირითადი მონაცემები)
            results.basicInfo = {};
            document.querySelectorAll('.infoTbl li dl').forEach(dl => {
                const key = dl.querySelector('dt')?.innerText.trim().replace(':', '');
                const val = dl.querySelector('dd')?.innerText.trim();
                if (key) results.basicInfo[key] = val;
            });

            // 4. Featured Information (ტექნიკური დეტალები)
            results.featuredInfo = {};
            document.querySelectorAll('.featureInfo .special li').forEach(li => {
                const key = li.querySelector('span')?.innerText.trim();
                const val = li.querySelector('b')?.innerText.trim();
                if (key) results.featuredInfo[key] = val;
            });

            // 5. Options (კომფორტის ოფციები)
            results.options = {};
            document.querySelectorAll('.optionInfo ul li').forEach(li => {
                const category = li.querySelector('h3, h2')?.innerText.trim() || "General";
                const list = Array.from(li.querySelectorAll('.list span')).map(s => s.innerText.trim());
                if (list.length > 0) results.options[category] = list;
            });

            // 6. VCR (Vehicle Condition Report)
            results.conditionReport = {};
            document.querySelectorAll('.statusArea').forEach(area => {
                const groupTitle = area.querySelector('strong')?.innerText.trim() || "Status";
                const items = {};
                area.querySelectorAll('li').forEach(li => {
                    const k = li.querySelector('dt')?.innerText.trim();
                    const v = li.querySelector('dd')?.innerText.trim();
                    if (k) items[k] = v;
                });
                results.conditionReport[groupTitle] = items;
            });

            return results;
        });

        console.log(`      ✅ წარმატებით ამოვიღე: ${data.title}`);
        return { ...data, url };

    } catch (e) {
        console.error(`      ⚠️ შეცდომა მონაცემების წაკითხვისას (${url}): ${e.message}`);
        return null;
    }
}

/**
 * მთავარი ფუნქცია
 */
(async () => {
    console.log("🚀 სკრაპერი ჩაირთო გარანტირებულ Headless რეჟიმში...");

    const browser = await puppeteer.launch({
        headless: true, // მხოლოდ ასე, ბრჭყალების გარეშე!
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-gpu',
        ]
    });

    try {
        const mainPage = await browser.newPage();
        const detailPage = await browser.newPage();
        
        // ბრაუზერის "ნიღაბი" (User Agent)
        await mainPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36');

        let allBatchData = [];

        for (let p = START_PAGE; p <= MAX_PAGES; p++) {
            const listUrl = `https://www.autowini.com/search/items?itemType=cars&condition=C020&pageOffset=${p}`;
            console.log(`\n📄 ვამუშავებ გვერდს: ${p}`);
            
            await mainPage.goto(listUrl, { waitUntil: 'networkidle2', timeout: 60000 });

            // ნელი ჩამოსქროლვა ლინკების გამოსაჩენად
            await mainPage.evaluate(async () => {
                await new Promise(resolve => {
                    let totalHeight = 0;
                    let timer = setInterval(() => {
                        window.scrollBy(0, 400);
                        totalHeight += 400;
                        if (totalHeight >= document.body.scrollHeight) { clearInterval(timer); resolve(); }
                    }, 150);
                });
            });

            // მანქანის ლინკების ამოკრება
            const carLinks = await mainPage.evaluate(() => {
                return Array.from(document.querySelectorAll('a[href*="/items/Used-"]'))
                    .map(a => a.href)
                    .filter((value, index, self) => self.indexOf(value) === index);
            });

            console.log(`🔗 გვერდზე ნაპოვნია ${carLinks.length} მანქანის ლინკი.`);

            if (carLinks.length === 0) {
                console.log("🏁 სია ცარიელია. პროცესი სრულდება.");
                break;
            }

            // სათითაოდ შევდივართ თითოეულ მანქანაში
            for (const link of carLinks) {
                const detailData = await scrapeCarDetail(detailPage, link);
                if (detailData) {
                    allBatchData.push(detailData);
                    
                    // RAM-ის დასაზოგად ვაგზავნით ყოველ 5 მანქანას
                    if (allBatchData.length >= 5) {
                        await sendBatch(allBatchData);
                    }
                }
                await sleep(3000); // ეთიკური პაუზა დაბლოკვის თავიდან ასაცილებლად
            }
        }

    } catch (err) {
        console.error("🛑 კრიტიკული სისტემური შეცდომა:", err.message);
    } finally {
        await browser.close();
        console.log("🏁 სკრაპერმა დაასრულა მუშაობა.");
    }
})();
