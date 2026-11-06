import {test,expect} from '@playwright/test';
import {PDFDocument,StandardFonts,rgb} from 'pdf-lib';
const appURL=process.env.LINEA_TEST_URL||'http://127.0.0.1:4173';
test.use({browserName:'chromium',headless:true,viewport:{width:1440,height:1060},deviceScaleFactor:2,
 launchOptions:{executablePath:process.env.CHROME_EXECUTABLE}});

async function openPlot(page){
 const doc=await PDFDocument.create(),font=await doc.embedFont(StandardFonts.Helvetica),p=doc.addPage([600,800]);
 p.drawText('Read this paragraph before the figure.',{x:60,y:730,size:12,font});
 for(const [a,b]of [[[100,490],[100,660]],[[100,490],[450,490]],[[100,510],[220,570]],[[220,570],[330,540]],[[330,540],[450,640]]])p.drawLine({start:{x:a[0],y:a[1]},end:{x:b[0],y:b[1]},thickness:1,color:rgb(0,0,0)});
 p.drawText('Legend',{x:320,y:630,size:10,font});p.drawText('time',{x:260,y:478,size:10,font});
 p.drawText('Figure 1: Read this caption after the figure.',{x:60,y:450,size:12,font});
 p.drawText('Continue reading the next paragraph.',{x:60,y:420,size:12,font});
 await page.goto(appURL);
 await page.locator('#file-input').setInputFiles({name:'figure-navigation.pdf',mimeType:'application/pdf',buffer:Buffer.from(await doc.save())});
 await expect(page.locator('#busy')).toBeHidden();
 await expect(page.locator('#text-layer span').first()).toBeAttached();
}
const text=(page,prefix)=>page.locator('#text-layer span').filter({hasText:prefix}).first();
async function focused(page,prefix){
 await expect.poll(()=>page.evaluate(prefix=>{
  const span=[...document.querySelectorAll('#text-layer span')].find(node=>node.textContent.startsWith(prefix));
  const box=span?.getBoundingClientRect(),focus=document.querySelector('#line-outline')?.getBoundingClientRect();
  return !!box&&!!focus&&focus.top<=box.top+box.height*.4&&focus.bottom>=box.top+box.height*.6;
 },prefix)).toBe(true);
}
test('keyboard traversal skips the chart and retains its caption',async({page})=>{
 await openPlot(page);await text(page,'Read this paragraph').click();await focused(page,'Read this paragraph');
 await page.keyboard.press('Enter');await focused(page,'Figure 1:');
 await page.keyboard.press('ArrowDown');await focused(page,'Continue reading');
 await page.keyboard.press('ArrowUp');await focused(page,'Figure 1:');
 await page.keyboard.press('ArrowUp');await focused(page,'Read this paragraph');
});
test('chart labels stay selectable but never become a reading stop',async({page})=>{
 await openPlot(page);await text(page,'Read this paragraph').click();
 const before=await page.locator('#line-position').textContent();
 await text(page,'Legend').click();
 await expect(page.locator('#line-position')).toHaveText(before);
 await text(page,'Legend').dblclick();
 await expect.poll(()=>page.evaluate(()=>getSelection().toString())).toBe('Legend');
 await expect(page.locator('#focus-layer')).toBeVisible();
 await expect(page.locator('#selection-menu')).toBeVisible();
});
