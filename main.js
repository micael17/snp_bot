const axios = require("axios");
const TelegramBot = require("node-telegram-bot-api");
const D3Node = require("d3-node");
const d3 = require("d3");

// API 설정
const FINNHUB_API_KEY = process.env.FINNHUB_API_KEY;
const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN;
const CHAT_ID = process.env.CHAT_ID;

if (!FINNHUB_API_KEY || !TELEGRAM_TOKEN || !CHAT_ID) {
  throw new Error("Required environment variables are not set");
}

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: false });
const finnhubClient = axios.create({
  baseURL: "https://finnhub.io/api/v1",
  headers: {
    "X-Finnhub-Token": FINNHUB_API_KEY,
  },
});

// S&P 500 종목 리스트 가져오기
async function getSP500Symbols() {
  try {
    // 인덱스 구성종목 조회
    const response = await finnhubClient.get("/index/constituents", {
      params: {
        symbol: "SPX", // S&P 500 인덱스
      },
    });

    if (!response.data || !response.data.constituents) {
      throw new Error("Failed to fetch S&P 500 constituents");
    }

    console.log(`Found ${response.data.constituents.length} S&P 500 stocks`);
    return response.data.constituents;
  } catch (error) {
    console.error("Error fetching S&P 500 symbols:", error.message);
    throw error;
  }
}

async function getStockData(symbol) {
  try {
    // 주가 데이터 가져오기
    const [quoteRes, candlesRes] = await Promise.all([
      finnhubClient.get(`/quote?symbol=${symbol}`),
      finnhubClient.get(`/stock/candle`, {
        params: {
          symbol: symbol,
          resolution: "D",
          from: Math.floor((Date.now() - 2 * 24 * 60 * 60 * 1000) / 1000),
          to: Math.floor(Date.now() / 1000),
        },
      }),
    ]);

    if (quoteRes.data.c === 0 || candlesRes.data.s !== "ok") {
      console.log(`No data available for ${symbol}`);
      return null;
    }

    // 일간 수익률 계산
    const currentPrice = candlesRes.data.c[candlesRes.data.c.length - 1];
    const previousPrice = candlesRes.data.c[candlesRes.data.c.length - 2];
    const dailyReturn = ((currentPrice - previousPrice) / previousPrice) * 100;

    return {
      symbol,
      dailyReturn,
      price: currentPrice,
      change: quoteRes.data.dp || dailyReturn,
    };
  } catch (error) {
    console.log(`Error fetching data for ${symbol}:`, error.message);
    return null;
  }
}

// 트리맵 차트 생성
function createTreemap(data) {
  const d3n = new D3Node(); // DOM 환경 생성
  const d3 = d3n.d3;
  const width = 1200;
  const height = 800;

  const svg = d3n
    .createSVG(width, height)
    .attr("xmlns", "http://www.w3.org/2000/svg");

  const hierarchy = d3
    .hierarchy({ children: data })
    .sum((d) => Math.abs(d.dailyReturn))
    .sort((a, b) => b.value - a.value);

  const treemap = d3.treemap().size([width, height]).padding(1);

  const root = treemap(hierarchy);

  // SVG 요소 그리기
  const cell = svg
    .selectAll("g")
    .data(root.leaves())
    .enter()
    .append("g")
    .attr("transform", (d) => `translate(${d.x0},${d.y0})`);

  cell
    .append("rect")
    .attr("width", (d) => d.x1 - d.x0)
    .attr("height", (d) => d.y1 - d.y0)
    .attr("fill", (d) => {
      const intensity = Math.min(Math.abs(d.data.dailyReturn) * 10, 255);
      return d.data.dailyReturn >= 0
        ? `rgb(0,${intensity},0)`
        : `rgb(${intensity},0,0)`;
    });

  cell
    .append("text")
    .attr("x", 5)
    .attr("y", 15)
    .attr("fill", "white")
    .text((d) => d.data.symbol);

  cell
    .append("text")
    .attr("x", 5)
    .attr("y", 30)
    .attr("fill", "white")
    .text((d) => `${d.data.dailyReturn.toFixed(1)}%`);

  return d3n.svgString();
}

async function run() {
  try {
    console.log("Starting update...", new Date().toLocaleString());

    // S&P 500 종목 리스트 가져오기
    const symbols = await getSP500Symbols();

    // 데이터 수집 (API 제한을 고려해 배치 처리)
    const batchSize = 30; // Finnhub 무료 티어는 분당 60회
    const stockData = [];

    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      console.log(
        `Processing batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(
          symbols.length / batchSize
        )}`
      );

      const batchData = await Promise.all(
        batch.map((symbol) => getStockData(symbol))
      );
      stockData.push(...batchData.filter((data) => data !== null));

      console.log(`Processed ${i + batchSize}/${symbols.length} stocks`);

      // API 제한을 피하기 위한 대기
      if (i + batchSize < symbols.length) {
        console.log("Waiting for rate limit...");
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
    }

    if (stockData.length === 0) {
      throw new Error("No stock data available");
    }

    // 트리맵 차트 생성
    const canvas = createTreemap(stockData);
    const imageBuffer = canvas.toBuffer("image/png");

    // 요약 통계 계산
    const stats = {
      averageReturn:
        stockData.reduce((sum, stock) => sum + stock.dailyReturn, 0) /
        stockData.length,
      gainers: stockData.filter((stock) => stock.dailyReturn > 0).length,
      losers: stockData.filter((stock) => stock.dailyReturn < 0).length,
      bestPerformer: stockData.reduce((best, stock) =>
        stock.dailyReturn > best.dailyReturn ? stock : best
      ),
      worstPerformer: stockData.reduce((worst, stock) =>
        stock.dailyReturn < worst.dailyReturn ? stock : worst
      ),
    };

    // 메시지 작성
    const message = `
            📊 S&P 500 수익률 요약 (${new Date().toLocaleString()})
            • 평균 수익률: ${stats.averageReturn.toFixed(2)}%
            • 상승 종목: ${stats.gainers}개
            • 하락 종목: ${stats.losers}개
            • 최고 수익률: ${
              stats.bestPerformer.symbol
            } (${stats.bestPerformer.dailyReturn.toFixed(2)}%)
            • 최저 수익률: ${
              stats.worstPerformer.symbol
            } (${stats.worstPerformer.dailyReturn.toFixed(2)}%)
            • 처리된 종목 수: ${stockData.length}개
        `;

    // 텔레그램으로 전송
    // SVG 문자열을 Buffer로 변환
    const svgBuffer = Buffer.from(svgString);

    // 텔레그램으로 전송
    await bot.sendDocument(CHAT_ID, svgBuffer, {
      filename: "treemap.svg",
      caption: message,
    });
    console.log("Update sent successfully");
  } catch (error) {
    console.error("Error in update:", error);
    await bot.sendMessage(CHAT_ID, `Error in update: ${error.message}`);
  }
}

// 앱 시작시 한 번 실행
run();

// 10분마다 실행
setInterval(run, 10 * 60 * 1000);

console.log("Bot started! Running every 10 minutes...");
