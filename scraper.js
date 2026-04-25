const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
puppeteer.use(StealthPlugin());
const axios = require('axios');

// ================= სისტემის პარამეტრები ================= 
const RECEIVER_URL = "https://masala.com.ge/pharmacy_receiver.php";
const SECRET_TOKEN = "MY_SUPER_SECRET_12345";
const FAILSAFE_LIMIT = 500; // უსასრულო ციკლის (Infinite Loop) დამცავი ბარიერი

const AVERSI_BASE_URL = 'https://shop.aversi.ge/ka/medication/';
const PSP_CATEGORY_ID = "823";
const IMPEX_TARGET_URL = "https://wolt.com/en/geo/tbilisi/venue/impex-melikishvili/items/menucategory-13";
// =======================================================

const sleep = ms => new Promise(res => setTimeout(res, ms));

async function autoScroll(page) {
    await page.evaluate(async () => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            let distance = 400;
            let timer = setInterval(() => {
                let scrollHeight = document.body.scrollHeight;
                window.scrollBy(0, distance);
                totalHeight += distance;
                if (totalHeight >= scrollHeight - window.innerHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    });
}

/**
 * მონაცემების გაგზავნა მიმღებთან (Batching/RAM Optimization)
 * ყოველი გაგზავნის შემდეგ მასივი სუფთავდება (productsArray.length = 0),
 * რათა Node.js-მა დაზოგოს ოპერატიული მეხსიერება (Prevent OutOfMemory).
 */
async function sendBatch(pharmacyId, pharmacyName, productsArray) {
    if (!productsArray || productsArray.length === 0) return;

    try {
        const payload = new URLSearchParams();
        payload.append('token', SECRET_TOKEN);
        payload.append('pharmacy_id', pharmacyId);
        payload.append('products', JSON.stringify(productsArray));

        console.log(`📡 [${pharmacyName}] აგზავნის ${productsArray.length} პროდუქტს მცირე ბატჩად...`);
        const response = await axios.post(RECEIVER_URL, payload);
        console.log(`✅ [${pharmacyName} DB]:`, response.data);

        // ვასუფთავებთ მასივს RAM-ის დასაზოგად!
        productsArray.length = 0;
    } catch (error) {
        console.error(`❌ [${pharmacyName} ბატჩის გაგზავნის ერორი]:`, error.message);
    }
}

(async () => {
    let browser = null;

    try {
        console.log(">> 🚀 [სისტემა] ვხსნით Puppeteer-ს...");
        browser = await puppeteer.launch({
            headless: "new",
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-web-security', '--window-size=1440,900']
        });
        const page = await browser.newPage();
        await page.setViewport({ width: 1440, height: 900 });

        // =============================================================
        // ეტაპი 1: AVERSI (pharmacy_id = 1)
        // =============================================================
        try {
            console.log("\n=========================================");
            console.log(">> 🔵 ეტაპი 1: ავერსი");
            console.log("=========================================");

            let aversiBatch = [];
            for (let i = 1; i <= FAILSAFE_LIMIT; i++) {
                let currentUrl = (i === 1) ? AVERSI_BASE_URL : `https://shop.aversi.ge/ka/medication/page-${i}/`;
                console.log(`-> [Aversi] გვერდი: ${i} | URL: ${currentUrl}`);

                await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                
                // Cloudflare Waiting Logic
                let cfWaitCount = 0; let pageTitle = await page.title();
                while ((pageTitle.includes('moment') || pageTitle.includes('Cloudflare')) && cfWaitCount < 10) {
                    await sleep(3000); pageTitle = await page.title(); cfWaitCount++;
                }

                await autoScroll(page); 
                await sleep(2500);

                const extracted = await page.evaluate(() => {
                    let items = [];
                    document.querySelectorAll('img[id^="det_img_"]').forEach(img => {
                        let cont = img.closest('form[name^="product_form_"]') || img.closest('.ty-column4') || img.parentElement.parentElement.parentElement.parentElement;
                        if (!cont) return;

                        let nmEl = cont.querySelector('.product-title') || cont.querySelector('.ty-grid-list__item-name');
                        let prEl = cont.querySelector('span[id^="sec_discounted_price_"]') || cont.querySelector('.ty-price-num');
                        let name = nmEl ? nmEl.innerText.trim() : "";
                        let price = prEl ? parseFloat(prEl.innerText.replace(',', '.').replace(/[^\d.]/g, '')) : 0;

                        if (name && price > 0) items.push({ name, price, image_url: (img.src || "") });
                    });
                    return items;
                });

                if (extracted.length === 0) {
                    console.log(`   🔸 ავერსიზე მეტი პროდუქტი არ მოიძებნა. (შეჩერდება მე-${i} გვერდზე)`);
                    break;
                }

                aversiBatch.push(...extracted);
                console.log(`   ✅ გვერდზე იპოვნა ${extracted.length} პროდუქტი.`);
                
                // ვგზავნით ყოველ გვერდზე (ან მასივის დაგროვებისას) და ვასუფთავებთ მეხსიერებას
                await sendBatch(1, "Aversi", aversiBatch);
            }
        } catch (err) {
            console.error(`❌ [Aversi კრიტიკული შეცდომა]: ${err.message}`);
        }


        // =============================================================
        // ეტაპი 2: PSP API (pharmacy_id = 2)
        // =============================================================
        try {
            console.log("\n=========================================");
            console.log(">> 🟠 ეტაპი 2: PSP (API)");
            console.log("=========================================");

            let pspBatch = [];
            const pspQuery = `query products($filter: ProductAttributeFilterInput, $sort: ProductAttributeSortInput, $pageSize: Int, $currentPage: Int) { products(filter: $filter, sort: $sort, pageSize: $pageSize, currentPage: $currentPage) { items { name price_range { maximum_price { final_price { value } } } thumbnail { url } } page_info { total_pages } } }`;

            for (let pgNum = 1; pgNum <= FAILSAFE_LIMIT; pgNum++) {
                console.log(`-> [PSP] მოთხოვნა API გვერდზე: ${pgNum}...`);
                let vars = { currentPage: pgNum, pageSize: 50, filter: { category_id: { eq: PSP_CATEGORY_ID } }, sort: {} };

                const resp = await axios.get("https://app.psp.ge/graphql", {
                    params: { query: pspQuery, variables: JSON.stringify(vars) },
                    headers: { 'Origin': 'https://psp.ge', 'Referer': 'https://psp.ge/' }
                });

                const items = resp.data?.data?.products?.items || [];
                if (items.length === 0) {
                    console.log(`   🔸 PSP-ზე მეტი პროდუქტი არ მოიძებნა.`);
                    break;
                }

                items.forEach(it => {
                    let nm = (it.name || '').trim();
                    let pr = it.price_range?.maximum_price?.final_price?.value || 0;
                    if (nm && pr > 0) pspBatch.push({ name: nm, price: pr, image_url: (it.thumbnail?.url || "") });
                });

                console.log(`   ✅ ამოვიღეთ ${items.length} ობიექტი.`);
                await sendBatch(2, "PSP", pspBatch);

                let totPg = resp.data?.data?.products?.page_info?.total_pages || 1;
                if (pgNum >= totPg) break;
            }
        } catch (err) {
            console.error(`❌ [PSP კრიტიკული შეცდომა]: ${err.message}`);
        }


        // =============================================================
        // ეტაპი 3: GPC (pharmacy_id = 3)
        // =============================================================
        try {
            console.log("\n=========================================");
            console.log(">> 🟢 ეტაპი 3: GPC");
            console.log("=========================================");

            let gpcBatch = [];
            for (let g = 1; g <= FAILSAFE_LIMIT; g++) {
                let currentUrl = `https://gpc.ge/ka/search?productTag=&page=${g}`;
                console.log(`-> [GPC] გვერდი: ${g} | URL: ${currentUrl}`);

                await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await autoScroll(page); 
                await sleep(2000);

                const extGpc = await page.evaluate(() => {
                    let tempItems = [];
                    document.querySelectorAll('a[href*="/ka/details/"]').forEach(card => {
                        let nameEl = card.querySelector('.line-clamp-2');
                        let name = nameEl ? nameEl.innerText.trim() : '';
                        if (!name) return;

                        let priceContentAttr = card.querySelector('[itemprop=""][content]');
                        let priceValue = priceContentAttr ? parseFloat(priceContentAttr.getAttribute('content')) :
                            parseFloat((card.querySelector('.flex.items-center')?.innerText || "0").replace(',', '.').replace(/[^\d.]/g, ''));
                        let imgTag = card.querySelector('img');
                        
                        if (name && priceValue > 0) {
                            tempItems.push({ name, price: priceValue, image_url: imgTag?.src || '' });
                        }
                    });
                    return tempItems;
                });

                if (extGpc.length === 0) {
                    console.log("   🔸 GPC-ზე პროდუქტები ამოიწურა.");
                    break;
                }

                gpcBatch.push(...extGpc);
                console.log(`   ✅ ნაპოვნია ${extGpc.length} ერთეული.`);
                await sendBatch(3, "GPC", gpcBatch);
            }
        } catch (err) {
            console.error(`❌ [GPC კრიტიკული შეცდომა]: ${err.message}`);
        }


        // =============================================================
        // ეტაპი 4: PharmaDepot (pharmacy_id = 4)
        // =============================================================
        try {
            console.log("\n=========================================");
            console.log(">> 🟣 ეტაპი 4: PharmaDepot");
            console.log("=========================================");

            let pharmaBatch = [];
            for (let ph = 1; ph <= FAILSAFE_LIMIT; ph++) {
                let currentUrl = (ph === 1) ? `https://pharmadepot.ge/ka/category` : `https://pharmadepot.ge/ka/category?page=${ph}`;
                console.log(`-> [PharmaDepot] გვერდი: ${ph} | URL: ${currentUrl}`);

                await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
                await autoScroll(page); 
                await sleep(2000);

                const extPharma = await page.evaluate(() => {
                    let tempItems = [];
                    document.querySelectorAll('a[href*="/ka/details/"]').forEach(card => {
                        let nameEl = card.querySelector('.line-clamp-2'); 
                        let name = nameEl ? nameEl.innerText.trim() : ''; 
                        if (!name) return;

                        let priceContentAttr = card.querySelector('[itemprop=""][content]');
                        let priceValue = priceContentAttr ? parseFloat(priceContentAttr.getAttribute('content')) : 
                            parseFloat((card.querySelector('.flex.items-center')?.innerText || "0").replace(',', '.').replace(/[^\d.]/g, ''));
                        let imgTag = card.querySelector('img');
                        
                        if (name && priceValue > 0) {
                            tempItems.push({ name, price: priceValue, image_url: imgTag?.src || '' });
                        }
                    });
                    return tempItems;
                });

                if (extPharma.length === 0) {
                    console.log("   🔸 PharmaDepot-ზე პროდუქტები ამოიწურა.");
                    break;
                }

                pharmaBatch.push(...extPharma);
                console.log(`   ✅ ნაპოვნია ${extPharma.length} ერთეული.`);
                await sendBatch(4, "PharmaDepot", pharmaBatch);
            }
        } catch (err) {
            console.error(`❌ [PharmaDepot კრიტიკული შეცდომა]: ${err.message}`);
        }


        // =============================================================
        // ეტაპი 5: Impex (Wolt Virtual Scroll) (pharmacy_id = 5)
        // =============================================================
        try {
            console.log("\n=========================================");
            console.log(">> 🔴 ეტაპი 5: Impex (Wolt Virtual Scroll)");
            console.log("=========================================");

            console.log(`-> [Impex] ვხსნით ვოლტის საიტს...`);
            await page.goto(IMPEX_TARGET_URL, { waitUntil: 'networkidle2', timeout: 90000 });
            await sleep(5000);

            // Popups & Overlays clear
            await page.evaluate(() => {
                document.querySelectorAll('[role="dialog"], header').forEach(el => el.style.display = 'none');
                let cookieBtn = document.querySelector('button[data-test-id="consent-banner-button-accept"]');
                if (cookieBtn) cookieBtn.click();
            });

            let sentUniqueUrls = new Set();
            let unchangedCount = 0;
            let impexBatch = [];

            // ციკლი ტრიალებს სანამ ზედიზედ 15-ჯერ ახალი პროდუქტი არ გაქრება (სქროლინგის ბოლო)
            while (unchangedCount < 15) {
                const snapshot = await page.evaluate(() => {
                    let foundThisTick = [];
                    let links = document.querySelectorAll('a[data-test-id="CardLinkButton"], a[href*="itemid-"]');

                    links.forEach(aTag => {
                        let uniqueUrl = aTag.href || Math.random().toString();
                        let wrapper = aTag;
                        let parentSteps = 0;
                        while (wrapper && wrapper.innerText.trim().length < 5 && parentSteps < 5 && wrapper.tagName !== 'BODY') {
                            wrapper = wrapper.parentElement;
                            parentSteps++;
                        }

                        let rawText = wrapper ? wrapper.innerText.trim() : "";
                        let lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0);

                        let pLine = lines.find(l => l.includes('₾') || l.includes('GEL'));
                        let priceVal = 0;
                        if (pLine) priceVal = parseFloat(pLine.replace(',', '.').replace(/[^\d.]/g, ''));

                        let nameLine = lines.find(l => !l.includes('₾') && !l.includes('GEL') && l.length > 3 && isNaN(l)) || "";
                        let imgNode = wrapper.querySelector('img');

                        if (nameLine && priceVal > 0) {
                            foundThisTick.push({
                                unique: uniqueUrl,
                                name: nameLine,
                                price: priceVal,
                                image_url: imgNode ? imgNode.src : ""
                            });
                        }
                    });
                    window.scrollBy(0, 500);
                    return foundThisTick;
                });

                let addedThisTick = 0;
                snapshot.forEach(item => {
                    if (!sentUniqueUrls.has(item.unique)) {
                        sentUniqueUrls.add(item.unique);
                        impexBatch.push({
                            name: item.name,
                            price: item.price,
                            image_url: item.image_url
                        });
                        addedThisTick++;
                    }
                });

                if (addedThisTick === 0) {
                    unchangedCount++;
                } else {
                    unchangedCount = 0;
                }

                // Node.js RAM Optimization: ვგზავნით როცა ბატჩი შეივსება 50-მდე
                if (impexBatch.length >= 50) {
                    await sendBatch(5, "Impex", impexBatch);
                }

                await sleep(800);
            }

            // ვგზავნით ნარჩენებს სქროლის დასრულების მერე
            if (impexBatch.length > 0) {
                await sendBatch(5, "Impex", impexBatch);
            }
            console.log("   🔸 Impex / Wolt სქროლინგი დასრულებულია.");

        } catch (err) {
            console.error(`❌ [Impex კრიტიკული შეცდომა]: ${err.message}`);
        }

    } catch (criticalErr) {
        console.error("\n[მთავარი კრიტიკული ერორი] ->", criticalErr);
    } finally {
        if (browser !== null) {
            console.log("\n>> 🏁 ყველა ამოცანა წარმატებით დასრულდა. ბრაუზერი დაიხურა!");
            await browser.close();
        }
    }
})();
