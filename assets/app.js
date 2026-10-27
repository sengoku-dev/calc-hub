/* かんたんお金計算 — 全ツール共通スクリプト（依存なし / ES2020）
 * 各ページの <div data-tool="..."> を起点に初期化する。
 * 計算ロジックは純粋関数として定義し、Node からも require できる（テスト用）。
 * 数値の根拠（検証日 2026-10-11）:
 *  - 所得税: 令和8年分（令和8年度税制改正後）。基礎控除 104万/67万/62万…、給与所得控除 最低74万円
 *  - 住民税: 所得割10%、均等割5,000円（森林環境税1,000円込み）、基礎控除43万円
 *  - 協会けんぽ東京 令和8年度: 健康保険9.85%、介護1.62%、子ども・子育て支援金0.23%（労使折半）
 *  - 厚生年金 18.3%（労使折半）、標準報酬月額上限65万円。雇用保険（一般）労働者負担0.5%
 *  - 雇用保険 基本手当: 令和8年8月1日改定の賃金日額・基本手当日額の上下限（厚労省 報道発表 令和8年7月31日）
 *  - 残業代: 労基法37条 割増率 25%／35%／25%、月60時間超50%（2023年4月〜全企業）。2026年10月時点で施行済み改正なし
 *  - 住民税: 令和9年度分（令和8年中の所得）。給与所得控除 最低74万円、非課税限度額（均等割 35万×人数+10万+21万 ※1級地、所得割 35万×人数+42万）、調整控除。2026-10-12 検証
 *  - iDeCo: 2026年12月施行の拠出限度額（第2号 6.2万円−企業年金等掛金相当額、第1号 7.5万円、第3号 2.3万円）、手数料 月186円・加入時2,829円。2026-10-26 検証
 *  - 年収の壁: 扶養の所得要件62万円（給与136万円）、配偶者特別控除・特定親族特別控除（令和8年分）、社保の賃金要件撤廃（2026-10-01）、被扶養者130/150/180万円未満。2026-10-19 検証
 */
(function (global) {
  'use strict';

  // ---------- 共通ユーティリティ ----------
  const yen = (n) => Math.round(n).toLocaleString('ja-JP');
  const man = (n) => (Math.round(n / 1000) / 10).toLocaleString('ja-JP'); // 万円（小数1桁）
  const floor100 = (n) => Math.floor(n / 100) * 100;
  const floor1000 = (n) => Math.floor(n / 1000) * 1000;
  // 社会保険料の被保険者負担分: 50銭以下切捨て・50銭超切上げ
  const roundPremium = (x) => { const f = Math.floor(x); return x - f > 0.5 ? f + 1 : f; };
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  // ---------- 税・社会保険の定数（2026年版） ----------
  const RATES = {
    kenpoTokyo: 0.0985,     // 協会けんぽ 東京都 健康保険料率（令和8年3月分〜）
    kaigo: 0.0162,          // 介護保険料率（全国一律, 40〜64歳）
    shienkin: 0.0023,       // 子ども・子育て支援金率（令和8年4月分〜, 全国一律）
    kosei: 0.183,           // 厚生年金保険料率
    koyo: 0.005,            // 雇用保険 労働者負担（一般の事業, 令和8年度）
    juminRate: 0.10,        // 住民税所得割
    juminKintowari: 5000,   // 均等割 4,000円 + 森林環境税 1,000円
    fukko: 1.021            // 復興特別所得税
  };

  // 健康保険 標準報酬月額 等級表（1〜50級）: [報酬月額の下限, 標準報酬月額]
  const KENPO_GRADES = [
    [0, 58000], [63000, 68000], [73000, 78000], [83000, 88000], [93000, 98000], [101000, 104000], [107000, 110000],
    [114000, 118000], [122000, 126000], [130000, 134000], [138000, 142000], [146000, 150000], [155000, 160000],
    [165000, 170000], [175000, 180000], [185000, 190000], [195000, 200000], [210000, 220000], [230000, 240000],
    [250000, 260000], [270000, 280000], [290000, 300000], [310000, 320000], [330000, 340000], [350000, 360000],
    [370000, 380000], [395000, 410000], [425000, 440000], [455000, 470000], [485000, 500000], [515000, 530000],
    [545000, 560000], [575000, 590000], [605000, 620000], [635000, 650000], [665000, 680000], [695000, 710000],
    [730000, 750000], [770000, 790000], [810000, 830000], [855000, 880000], [905000, 930000], [955000, 980000],
    [1005000, 1030000], [1055000, 1090000], [1115000, 1150000], [1175000, 1210000], [1235000, 1270000],
    [1295000, 1330000], [1355000, 1390000]
  ];
  function standardMonthly(monthly, cap) {
    let smr = KENPO_GRADES[0][1];
    for (const [lo, v] of KENPO_GRADES) if (monthly >= lo) smr = v;
    if (cap) smr = clamp(smr, 88000, cap); // 厚生年金は 88,000〜650,000（1〜32級）
    return smr;
  }

  // 給与所得控除（令和8年分 / 住民税は令和9年度分）。最低保障74万円（収入220万円以下）
  function kyuyoKojo(income) {
    if (income <= 2200000) return Math.min(income, 740000);
    if (income <= 3600000) return income * 0.3 + 80000;
    if (income <= 6600000) return income * 0.2 + 440000;
    if (income <= 8500000) return income * 0.1 + 1100000;
    return 1950000;
  }
  const kyuyoShotoku = (income) => Math.max(0, income - kyuyoKojo(income));

  // 所得税 基礎控除（令和8年分: 本則62万 + 特例加算）
  function kisoKojoShotoku(goukei) {
    if (goukei <= 4890000) return 1040000;
    if (goukei <= 6550000) return 670000;
    if (goukei <= 23500000) return 620000;
    if (goukei <= 24000000) return 480000;
    if (goukei <= 24500000) return 320000;
    if (goukei <= 25000000) return 160000;
    return 0;
  }
  // 住民税 基礎控除（43万円、合計所得2,400万円超で逓減）
  function kisoKojoJumin(goukei) {
    if (goukei <= 24000000) return 430000;
    if (goukei <= 24500000) return 290000;
    if (goukei <= 25000000) return 150000;
    return 0;
  }

  // 所得税の速算表（課税所得は1,000円未満切捨て済みで渡す）。復興特別所得税込み、100円未満切捨て
  const TAX_TABLE = [
    [1950000, 0.05, 0], [3300000, 0.10, 97500], [6950000, 0.20, 427500], [9000000, 0.23, 636000],
    [18000000, 0.33, 1536000], [40000000, 0.40, 2796000], [Infinity, 0.45, 4796000]
  ];
  function incomeTaxRate(kazei) { for (const r of TAX_TABLE) if (kazei <= r[0]) return r[1]; return 0.45; }
  function incomeTax(kazei) {
    if (kazei <= 0) return 0;
    for (const [lim, rate, ded] of TAX_TABLE) if (kazei <= lim) return floor100((kazei * rate - ded) * RATES.fukko);
    return 0;
  }

  // 住民税の調整控除（人的控除の差額に基づく）
  function chouseiKojo(kazeiJumin, jinteki) {
    if (kazeiJumin <= 0) return 0;
    let v;
    if (kazeiJumin <= 2000000) v = Math.min(jinteki, kazeiJumin) * 0.05;
    else v = Math.max((jinteki - (kazeiJumin - 2000000)) * 0.05, 2500);
    return Math.floor(v);
  }

  /** 年収から手取り（給与所得者・東京・協会けんぽ） */
  function calcTedori(opt) {
    const income = Math.max(0, Math.floor(opt.income || 0));
    const age = opt.age || 30;
    const dep = clamp(Math.floor(opt.dependents || 0), 0, 20);          // 一般扶養親族（配偶者控除含む）
    if (income <= 0) return { income: 0, age, dependents: dep, smrK: 0, smrP: 0, kenpo: 0, kaigo: 0, shienkin: 0, kosei: 0, koyo: 0, shaho: 0, kyuyo: 0, kisoS: 0, fuyoS: 0, kazeiS: 0, shotokuzei: 0, taxRate: 0, kisoJ: 0, kazeiJ: 0, shotokuwari: 0, kintowari: 0, juminzei: 0, tedori: 0, tedoriMonthly: 0, rate: 0 };
    const monthly = income / 12;
    const smrK = standardMonthly(monthly);
    const smrP = standardMonthly(monthly, 650000);
    const kenpo = roundPremium(smrK * RATES.kenpoTokyo / 2) * 12;
    const kaigo = age >= 40 && age < 65 ? roundPremium(smrK * RATES.kaigo / 2) * 12 : 0;
    const shienkin = roundPremium(smrK * RATES.shienkin / 2) * 12;
    const kosei = age < 70 ? roundPremium(smrP * RATES.kosei / 2) * 12 : 0;
    const koyo = Math.round(income * RATES.koyo);
    const shaho = kenpo + kaigo + shienkin + kosei + koyo;

    const kyuyo = kyuyoShotoku(income);
    // 所得税
    const kisoS = kisoKojoShotoku(kyuyo);
    const fuyoS = dep * 380000;
    const kazeiS = floor1000(Math.max(0, kyuyo - shaho - kisoS - fuyoS));
    const shotokuzei = incomeTax(kazeiS);
    // 住民税（翌年度課税だが、年収ベースの概算として同年に計上）
    const kisoJ = kisoKojoJumin(kyuyo);
    const fuyoJ = dep * 330000;
    const kazeiJ = floor1000(Math.max(0, kyuyo - shaho - kisoJ - fuyoJ));
    const nonTaxLine = dep > 0 ? 350000 * (dep + 1) + 310000 : 450000; // 均等割非課税の目安（東京23区等）
    let shotokuwari = 0, kintowari = 0;
    if (kyuyo > nonTaxLine) {
      const jinteki = 50000 + dep * 50000; // 基礎控除差5万 + 扶養控除差5万/人
      shotokuwari = Math.max(0, floor100(kazeiJ * RATES.juminRate) - chouseiKojo(kazeiJ, jinteki));
      shotokuwari = floor100(shotokuwari);
      kintowari = RATES.juminKintowari;
    }
    const juminzei = shotokuwari + kintowari;
    const tedori = income - shaho - shotokuzei - juminzei;
    return {
      income, age, dependents: dep, smrK, smrP,
      kenpo, kaigo, shienkin, kosei, koyo, shaho,
      kyuyo, kisoS, fuyoS, kazeiS, shotokuzei, taxRate: incomeTaxRate(kazeiS),
      kisoJ, kazeiJ, shotokuwari, kintowari, juminzei,
      tedori, tedoriMonthly: tedori / 12, rate: income ? tedori / income : 0
    };
  }

  /** 住宅ローン返済 */
  function calcLoan(opt) {
    const P = Math.max(0, Math.floor(opt.principal || 0));
    const annual = Math.max(0, +opt.rate || 0) / 100;
    const years = clamp(Math.floor(opt.years || 35), 1, 50);
    const type = opt.type === 'gankin' ? 'gankin' : 'ganri';
    const bonusP = clamp(Math.floor(opt.bonusPrincipal || 0), 0, P); // ボーナス返済に充てる借入額
    const prepay = Math.max(0, Math.floor(opt.prepay || 0));
    const prepayYear = clamp(Math.floor(opt.prepayYear || 0), 0, years);

    function simulate(principal, periodsPerYear, extra) {
      const n = years * periodsPerYear;
      const r = annual / periodsPerYear;
      let bal = principal;
      const pmt0 = r > 0 ? principal * r / (1 - Math.pow(1 + r, -n)) : principal / n; // 元利均等
      const prin0 = principal / n;                                                      // 元金均等の元金部分
      const rows = []; // 期ごと
      let totalInt = 0, totalPay = 0, k = 0;
      const extraAt = extra && extra.amount > 0 && extra.year > 0 ? extra.year * periodsPerYear : -1;
      while (bal > 0.5 && k < n * 3) {
        k++;
        const interest = bal * r;
        let pay;
        if (type === 'ganri') pay = Math.min(pmt0, bal + interest);
        else pay = Math.min(prin0 + interest, bal + interest);
        const prin = pay - interest;
        bal -= prin;
        if (bal <= 0.5) bal = 0; // 浮動小数の残りカスを切り捨て
        totalInt += interest; totalPay += pay;
        let extraPaid = 0;
        if (k === extraAt) { extraPaid = Math.min(extra.amount, bal); bal -= extraPaid; totalPay += extraPaid; }
        rows.push({ k, pay, interest, prin, extraPaid, bal: Math.max(0, bal) });
        if (bal <= 0.5) { bal = 0; break; }
      }
      return { pmt: type === 'ganri' ? pmt0 : prin0 + principal * r, firstPay: rows[0] ? rows[0].pay : 0, lastPay: rows.length ? rows[rows.length - 1].pay : 0, rows, periods: k, totalInt, totalPay };
    }
    const monthlyPart = simulate(P - bonusP, 12, prepay > 0 ? { amount: prepay, year: prepayYear } : null);
    const bonusPart = bonusP > 0 ? simulate(bonusP, 2, null) : null;
    const base = prepay > 0 ? simulate(P - bonusP, 12, null) : monthlyPart;

    // 年別集計（月払い＋ボーナス）
    const yearly = [];
    for (let y = 1; y <= years; y++) {
      const mrows = monthlyPart.rows.slice((y - 1) * 12, y * 12);
      const brows = bonusPart ? bonusPart.rows.slice((y - 1) * 2, y * 2) : [];
      const pay = mrows.reduce((s, r) => s + r.pay + r.extraPaid, 0) + brows.reduce((s, r) => s + r.pay, 0);
      const int = mrows.reduce((s, r) => s + r.interest, 0) + brows.reduce((s, r) => s + r.interest, 0);
      const balM = mrows.length ? mrows[mrows.length - 1].bal : 0;
      const balB = brows.length ? brows[brows.length - 1].bal : (bonusPart && y * 2 > bonusPart.rows.length ? 0 : 0);
      yearly.push({ year: y, pay, interest: int, bal: balM + balB });
      if (balM + balB <= 0 && y < years && !bonusPart) break;
    }
    const totalInt = monthlyPart.totalInt + (bonusPart ? bonusPart.totalInt : 0);
    const totalPay = monthlyPart.totalPay + (bonusPart ? bonusPart.totalPay : 0);
    const baseInt = base.totalInt + (bonusPart ? bonusPart.totalInt : 0);
    return {
      principal: P, rate: annual * 100, years, type, bonusPrincipal: bonusP,
      monthlyPay: monthlyPart.firstPay, monthlyPayLast: monthlyPart.lastPay,
      bonusPay: bonusPart ? bonusPart.firstPay : 0,
      totalInt, totalPay, yearly,
      balances: monthlyPart.rows.map(r => r.bal),
      baseBalances: base.rows.map(r => r.bal),
      prepay: prepay > 0 ? {
        amount: prepay, year: prepayYear,
        monthsSaved: base.periods - monthlyPart.periods,
        interestSaved: baseInt - totalInt,
        endMonths: monthlyPart.periods
      } : null
    };
  }

  /** ふるさと納税 控除上限額（総務省の計算式） */
  function calcFurusato(opt) {
    const income = Math.max(0, Math.floor(opt.income || 0));
    const family = opt.family || 'single'; // single | dual | spouse(配偶者を扶養)
    const hs = clamp(Math.floor(opt.highschool || 0), 0, 10);   // 16〜18歳（一般扶養 38万/33万）
    const univ = clamp(Math.floor(opt.university || 0), 0, 10); // 19〜22歳（特定扶養 63万/45万）
    const shaho = calcTedori({ income, age: opt.age || 30, dependents: 0 }).shaho; // 社会保険料は手取りツールと同じ前提
    const kyuyo = kyuyoShotoku(income);
    const spouse = family === 'spouse' ? 1 : 0;
    const kojoS = kisoKojoShotoku(kyuyo) + spouse * 380000 + hs * 380000 + univ * 630000;
    const kojoJ = kisoKojoJumin(kyuyo) + spouse * 330000 + hs * 330000 + univ * 450000;
    const kazeiS = floor1000(Math.max(0, kyuyo - shaho - kojoS));
    const kazeiJ = floor1000(Math.max(0, kyuyo - shaho - kojoJ));
    const jinteki = 50000 + spouse * 50000 + hs * 50000 + univ * 180000;
    const shotokuwari = Math.max(0, floor100(kazeiJ * RATES.juminRate) - chouseiKojo(kazeiJ, jinteki));
    const rate = incomeTaxRate(kazeiS);
    const limit = shotokuwari > 0 ? shotokuwari * 0.2 / (0.9 - rate * RATES.fukko) + 2000 : 0;
    const limitFloor = Math.floor(limit / 1000) * 1000; // 1,000円未満切捨て（安全側）
    return { income, family, hs, univ, shaho, kyuyo, kazeiS, kazeiJ, shotokuwari, rate, limit, limitFloor };
  }

  /** 積立シミュレーション */
  function calcTsumitate(opt) {
    const monthly = Math.max(0, Math.floor(opt.monthly || 0));
    const initial = Math.max(0, Math.floor(opt.initial || 0));
    const annual = Math.max(-0.5, (+opt.rate || 0) / 100);
    const years = clamp(Math.floor(opt.years || 0), 1, 60);
    const r = annual / 12;
    let bal = initial, paid = initial;
    const series = [{ year: 0, bal, paid }];
    for (let y = 1; y <= years; y++) {
      for (let m = 0; m < 12; m++) { bal = bal * (1 + r) + monthly; paid += monthly; }
      series.push({ year: y, bal, paid });
    }
    const n = years * 12;
    const fvFactor = r !== 0 ? (Math.pow(1 + r, n) - 1) / r : n;
    const target = Math.max(0, Math.floor(opt.target || 0));
    const needMonthly = target > 0 ? Math.max(0, (target - initial * Math.pow(1 + r, n)) / fvFactor) : 0;
    // 取り崩し: 初年度に資産の withdrawRate を取り出し、以後同額（定額）を毎年取り崩す
    const wRate = clamp(+opt.withdrawRate || 4, 0.1, 50) / 100;
    const wReturn = (opt.withdrawReturn != null ? +opt.withdrawReturn : opt.rate || 0) / 100;
    const annualW = bal * wRate;
    let wb = bal, wyears = 0;
    const wSeries = [wb];
    while (wb > 0 && wyears < 100) {
      wb = wb * (1 + wReturn) - annualW; wyears++;
      wSeries.push(Math.max(0, wb));
    }
    const forever = wyears >= 100 && wb > 0;
    return {
      monthly, initial, rate: annual * 100, years, final: bal, paid, gain: bal - paid, series,
      target, needMonthly, withdrawAnnual: annualW, withdrawMonthly: annualW / 12,
      withdrawYears: forever ? Infinity : wyears, withdrawSeries: wSeries,
      nisaYears: monthly > 0 ? Math.min(years, Math.ceil(18000000 / Math.min(monthly * 12, 3600000))) : 0,
      nisaOverMonthly: monthly * 12 > 3600000
    };
  }

  /** 退職金の手取り */
  function calcTaishokukin(opt) {
    const amount = Math.max(0, Math.floor(opt.amount || 0));
    const yearsRaw = Math.max(0, +opt.years || 0);
    const years = Math.max(1, Math.ceil(yearsRaw)); // 1年未満の端数は切上げ
    const officer = !!opt.officer; // 役員等で勤続5年以下
    let kojo = years <= 20 ? 400000 * years : 8000000 + 700000 * (years - 20);
    kojo = Math.max(kojo, 800000);
    if (opt.disability) kojo += 1000000;
    const excess = Math.max(0, amount - kojo);
    let kazei;
    if (officer && years <= 5) kazei = excess;                       // 特定役員: 1/2なし
    else if (years <= 5 && excess > 3000000) kazei = 1500000 + (excess - 3000000); // 短期退職手当等
    else kazei = excess / 2;
    kazei = floor1000(kazei);
    const shotokuzei = incomeTax(kazei);
    const juminzei = floor100(kazei * RATES.juminRate);
    const tedori = amount - shotokuzei - juminzei;
    return { amount, years, kojo, excess, kazei, shotokuzei, juminzei, tedori, rate: amount ? (shotokuzei + juminzei) / amount : 0, taxRate: incomeTaxRate(kazei) };
  }

  /** 失業保険（雇用保険の基本手当）: 賃金日額→基本手当日額・所定給付日数
   *  根拠: 厚生労働省「基本手当日額の計算式及び金額（令和8年8月1日〜）」、報道発表（令和8年7月31日）。検証日 2026-10-11
   *  年齢区分ごとに { 80%区間の上限A, 逓減区間の上限B, 賃金日額の上限wCap, 基本手当日額の上限dailyCap, 逓減幅k } */
  const SHITSUGYO = {
    wMin: 3203, dailyMin: 2562,
    brackets: [
      { key: 'u30', label: '29歳以下', maxAge: 29, A: 5480, B: 13490, wCap: 14900, dailyCap: 7450, k: 0.30 },
      { key: 'a30', label: '30〜44歳', maxAge: 44, A: 5480, B: 13490, wCap: 16540, dailyCap: 8270, k: 0.30 },
      { key: 'a45', label: '45〜59歳', maxAge: 59, A: 5480, B: 13490, wCap: 18220, dailyCap: 9110, k: 0.30 },
      { key: 'a60', label: '60〜64歳', maxAge: 64, A: 5480, B: 12120, wCap: 17400, dailyCap: 7830, k: 0.35 }
    ]
  };
  function shitsugyoBracket(age) {
    const a = Math.floor(age || 0);
    if (a >= 65) return SHITSUGYO.brackets[0]; // 65歳以上（高年齢求職者給付金）は30歳未満と同じ日額
    for (const b of SHITSUGYO.brackets) if (a <= b.maxAge) return b;
    return SHITSUGYO.brackets[3];
  }
  /** 基本手当日額（1円未満切捨て）。w: 賃金日額 = 離職前6か月の賃金（賞与除く）÷180 */
  function kihonTeate(w, age) {
    const b = shitsugyoBracket(age);
    w = Math.max(SHITSUGYO.wMin, Math.floor(w || 0));
    let y;
    if (w < b.A) y = 0.8 * w;
    else if (w <= b.B) {
      y = 0.8 * w - b.k * ((w - b.A) / (b.B - b.A)) * w;
      if (b.key === 'a60') y = Math.min(y, 0.05 * w + b.B * 0.4); // 60〜64歳はいずれか低い額
    } else if (w <= b.wCap) y = (b.key === 'a60' ? 0.45 : 0.5) * w;
    else y = b.dailyCap;
    return clamp(Math.floor(y), SHITSUGYO.dailyMin, b.dailyCap);
  }
  // 所定給付日数（日）。年齢区分 [〜29, 30〜34, 35〜44, 45〜59, 60〜64] × 被保険者期間 [1年未満, 1〜5, 5〜10, 10〜20, 20年以上]
  const DAYS_TOKUTEI = [
    [90, 90, 120, 180, 180],
    [90, 120, 180, 210, 240],
    [90, 150, 180, 240, 270],
    [90, 180, 240, 270, 330],
    [90, 150, 180, 210, 240]
  ];
  const DAYS_IPPAN = [0, 90, 90, 120, 150]; // 一般の受給資格者（1年未満は原則受給資格なし）
  function kyufuNissu(age, years, reason) {
    const a = Math.floor(age || 0), y = Math.max(0, +years || 0);
    const yi = y < 1 ? 0 : y < 5 ? 1 : y < 10 ? 2 : y < 20 ? 3 : 4;
    if (a >= 65) return y < 1 ? 30 : 50; // 高年齢求職者給付金（一時金）
    if (reason === 'konnan') return y < 1 ? 150 : (a < 45 ? 300 : 360);
    if (reason === 'tokutei') { const ai = a < 30 ? 0 : a < 35 ? 1 : a < 45 ? 2 : a < 60 ? 3 : 4; return DAYS_TOKUTEI[ai][yi]; }
    return DAYS_IPPAN[yi];
  }
  /** 失業保険シミュレーション */
  function calcShitsugyo(opt) {
    const salary = Math.max(0, Math.floor(opt.salary || 0)); // 離職前6か月の平均月給（賞与除く, 円）
    const age = clamp(Math.floor(opt.age || 35), 15, 80);
    const years = Math.max(0, +opt.years || 0);
    const reason = opt.reason === 'tokutei' || opt.reason === 'konnan' ? opt.reason : 'ippan';
    const b = shitsugyoBracket(age);
    const w = Math.floor(salary * 6 / 180);
    const wUsed = clamp(w, SHITSUGYO.wMin, b.wCap);
    const daily = salary > 0 ? kihonTeate(w, age) : 0;
    // 受給資格: 一般は離職前2年に12か月以上、特定受給資格者・特定理由離職者は離職前1年に6か月以上
    const eligible = reason === 'ippan' ? years >= 1 : years >= 0.5;
    const days = eligible ? kyufuNissu(age, years, reason) : 0;
    const total = daily * days;
    const senior = age >= 65;
    const restrictionMonths = senior ? 0 : reason === 'ippan' ? 1 : 0; // 自己都合は原則1か月（2025年4月1日以降の離職）
    return {
      salary, age, years, reason, bracket: b.label, w, wUsed, daily, rate: w > 0 ? daily / w : 0,
      capped: w > b.wCap, floored: w < SHITSUGYO.wMin, eligible, days, total,
      per28: daily * 28, senior, waitingDays: 7, restrictionMonths
    };
  }

  /** 残業代・固定残業代チェッカー
   *  根拠: 労働基準法37条（時間外25%・休日35%・深夜25%、月60時間超50%は令和5年4月から中小企業も適用）、
   *  労基則19条・21条（1時間あたり賃金＝月給÷月平均所定労働時間、除外賃金7種）、昭和63.3.14 基発150号（端数処理）。検証日 2026-10-11 */
  const ZANGYO_RATES = { ot: 0.25, ot60: 0.50, night: 0.25, holiday: 0.35, threshold: 60 };
  const round50 = (x) => Math.floor(x + 0.5); // 50銭未満切捨て・50銭以上切上げ（通達の端数処理）
  function calcZangyo(opt) {
    const salary = Math.max(0, Math.floor(opt.salary || 0));             // 月給（固定残業代を除く・円）
    const excluded = clamp(Math.floor(opt.excluded || 0), 0, salary);    // 除外できる手当（通勤・家族・住宅など）
    const dayHours = clamp(+opt.dayHours || 8, 1, 24);
    const holidays = clamp(Math.floor(opt.holidays != null && opt.holidays !== '' ? opt.holidays : 120), 0, 300);
    const monthlyHours = opt.monthlyHours > 0 ? +opt.monthlyHours : (365 - holidays) * dayHours / 12; // 月平均所定労働時間
    const overtime = clamp(+opt.overtime || 0, 0, 400);                  // 法定時間外（月）
    const night = clamp(+opt.night || 0, 0, overtime);                   // うち深夜（22〜5時）
    const holiday = clamp(+opt.holiday || 0, 0, 400);                    // 法定休日労働（月）
    const holidayNight = clamp(+opt.holidayNight || 0, 0, holiday);      // うち深夜
    const fixedAmount = Math.max(0, Math.floor(opt.fixedAmount || 0));   // 固定残業代（月額）
    const fixedHours = Math.max(0, +opt.fixedHours || 0);                // 固定残業代の時間数
    const basis = Math.max(0, salary - excluded);
    const hourly = monthlyHours > 0 ? round50(basis / monthlyHours) : 0; // 1時間あたりの基礎賃金
    const ot25h = Math.min(overtime, ZANGYO_RATES.threshold), ot50h = Math.max(0, overtime - ZANGYO_RATES.threshold);
    const ot25 = round50(hourly * (1 + ZANGYO_RATES.ot) * ot25h);
    const ot50 = round50(hourly * (1 + ZANGYO_RATES.ot60) * ot50h);
    const nightPay = round50(hourly * ZANGYO_RATES.night * night);
    const holidayPay = round50(hourly * (1 + ZANGYO_RATES.holiday) * holiday);
    const holidayNightPay = round50(hourly * ZANGYO_RATES.night * holidayNight);
    const total = ot25 + ot50 + nightPay + holidayPay + holidayNightPay;
    const otHourly25 = round50(hourly * 1.25), otHourly50 = round50(hourly * 1.5), holidayHourly = round50(hourly * 1.35);
    // 固定残業代チェック
    const fixedImpliedHours = hourly > 0 && fixedAmount > 0 ? fixedAmount / (hourly * 1.25) : 0; // 固定残業代が何時間分に相当するか
    const fixedPerHour = fixedHours > 0 && fixedAmount > 0 ? fixedAmount / fixedHours : 0;
    const fixedUnderLegal = fixedPerHour > 0 && fixedPerHour + 0.5 < hourly * 1.25;              // 1時間あたり単価が法定を下回る
    const fixedOver45 = fixedHours > 45;                                                          // 36協定の原則上限45時間超
    const shortage = fixedAmount > 0 ? Math.max(0, total - fixedAmount) : 0;                      // 固定残業代を超えた分（差額）
    const overFixedHours = fixedHours > 0 ? Math.max(0, overtime - fixedHours) : 0;
    const monthlyTotal = salary + (fixedAmount > 0 ? Math.max(fixedAmount, total) : total);      // 残業代込みの月収（額面）
    return {
      salary, excluded, basis, dayHours, holidays, monthlyHours, hourly,
      overtime, night, holiday, holidayNight, ot25h, ot50h, ot25, ot50, nightPay, holidayPay, holidayNightPay, total,
      otHourly25, otHourly50, holidayHourly,
      fixedAmount, fixedHours, fixedImpliedHours, fixedPerHour, fixedUnderLegal, fixedOver45, shortage, overFixedHours,
      monthlyTotal, annual: total * 12, threeYears: total * 36
    };
  }

  /** 住民税（個人住民税・給与所得者）: 令和8年中の給与収入 → 令和9年度分（2027年6月〜）の住民税
   *  根拠: 地方税法（所得割 市町村6%・道府県4%、均等割 3,000円＋1,000円、森林環境税1,000円）、
   *  令和8年度税制改正（給与所得控除の最低保障74万円 = 令和9・10年度分）、非課税限度額（地方税法295条・附則3条の3、施行令47条の3）、
   *  調整控除（地方税法314条の6）。検証日 2026-10-12 */
  const JUMIN = {
    shiRate: 0.06, kenRate: 0.04, kintoShi: 3000, kintoKen: 1000, shinrin: 1000,
    // 均等割の非課税限度額（合計所得金額）: 基本額×(人数) + 10万 + 加算額（扶養ありのみ）。級地は生活保護の級地区分
    kyuchi: { 1: [350000, 210000], 2: [315000, 189000], 3: [280000, 168000] },
    tokurei: 1350000 // 障害者・未成年者・寡婦・ひとり親: 合計所得135万円以下は非課税
  };
  // 住民税の配偶者控除（本人の合計所得で逓減）と、調整控除用の人的控除差
  function haigushaJumin(goukei) { return goukei <= 9000000 ? [330000, 50000] : goukei <= 9500000 ? [220000, 40000] : goukei <= 10000000 ? [110000, 20000] : [0, 0]; }
  function calcJuminzei(opt) {
    const income = Math.max(0, Math.floor(opt.income || 0));
    const age = opt.age || 30;
    const spouse = opt.spouse ? 1 : 0;                                   // 控除対象配偶者（配偶者の合計所得62万円以下）
    const ippan = clamp(Math.floor(opt.ippan || 0), 0, 20);             // 一般の扶養親族（16〜18歳・23〜69歳）
    const tokutei = clamp(Math.floor(opt.tokutei || 0), 0, 20);         // 特定扶養親族（19〜22歳）
    const under16 = clamp(Math.floor(opt.under16 || 0), 0, 20);         // 16歳未満の扶養親族（控除なし・非課税判定の人数には入る）
    const kyuchi = JUMIN.kyuchi[opt.kyuchi] ? +opt.kyuchi : 1;
    const tokurei = !!opt.tokurei;
    const other = Math.max(0, Math.floor(opt.otherKojo || 0));          // その他の所得控除（住民税の額）
    const shaho = opt.shaho != null && opt.shaho !== '' && +opt.shaho >= 0 ? Math.floor(+opt.shaho) : calcTedori({ income, age, dependents: 0 }).shaho;
    const kyuyo = kyuyoShotoku(income);                                  // 合計所得金額＝総所得金額等（給与のみ）
    const n = spouse + ippan + tokutei + under16;
    // 非課税判定
    const [k1, k2] = JUMIN.kyuchi[kyuchi];
    const kintoLine = n > 0 ? k1 * (n + 1) + 100000 + k2 : k1 + 100000;
    const shotokuLine = n > 0 ? 350000 * (n + 1) + 420000 : 450000;
    const tokureiHit = tokurei && kyuyo <= JUMIN.tokurei;
    const kintoFree = tokureiHit || kyuyo <= kintoLine;
    const shotokuFree = tokureiHit || kyuyo <= shotokuLine;
    // 所得控除（住民税）
    const kiso = kisoKojoJumin(kyuyo);
    const [haiK, haiDiff] = spouse ? haigushaJumin(kyuyo) : [0, 0];
    const fuyo = ippan * 330000 + tokutei * 450000;
    const kojo = shaho + kiso + haiK + fuyo + other;
    const kazei = floor1000(Math.max(0, kyuyo - kojo));
    // 調整控除（合計所得2,500万円超は適用なし）。市町村3%・道府県2%に按分
    const jinteki = 50000 + haiDiff + ippan * 50000 + tokutei * 180000;
    const chousei = kyuyo > 25000000 ? 0 : chouseiKojo(kazei, jinteki);
    let shi = 0, ken = 0;
    if (!shotokuFree && kazei > 0) {
      shi = floor100(Math.max(0, kazei * JUMIN.shiRate - chousei * 0.6));
      ken = floor100(Math.max(0, kazei * JUMIN.kenRate - chousei * 0.4));
    }
    const shotokuwari = shi + ken;
    const kintowari = kintoFree ? 0 : JUMIN.kintoShi + JUMIN.kintoKen;
    const shinrin = kintoFree ? 0 : JUMIN.shinrin;
    const total = shotokuwari + kintowari + shinrin;
    // 特別徴収（6月〜翌5月の12回）: 12分の1の100円未満の端数は6月分に合算。普通徴収（4期）: 1,000円未満の端数は第1期に合算
    const monthly = floor100(total / 12), june = total - monthly * 11;
    const ki = floor1000(total / 4), ki1 = total - ki * 3;
    return {
      income, age, spouse, ippan, tokutei, under16, n, kyuchi, tokurei, other,
      shaho, kyuyo, kiso, haiK, fuyo, kojo, kazei, jinteki, chousei,
      kintoLine, shotokuLine, kintoFree, shotokuFree, tokureiHit,
      shi, ken, shotokuwari, kintowari, shinrin, total,
      monthly, june, ki, ki1, rate: income ? total / income : 0
    };
  }
  /** 住民税がかからない給与収入の上限（1,000円単位で探索） */
  function juminHikazeiIncome(opt, kind) {
    let lo = 0, hi = 10000000;
    const free = (inc) => { const r = calcJuminzei(Object.assign({}, opt, { income: inc, shaho: 0 })); return kind === 'shotoku' ? r.shotokuFree : r.kintoFree; };
    while (hi - lo > 1000) { const mid = floor1000((lo + hi) / 2); if (free(mid)) lo = mid; else hi = mid; }
    return lo;
  }

  /** 年収の壁 判定（令和8年分の所得税・令和9年度分の住民税・2026年10月時点の社会保険）
   *  根拠: 国税庁 タックスアンサー No.1191 配偶者控除／No.1195 配偶者特別控除／No.1177 特定親族特別控除（令和8年分、令和8年12月1日施行）、
   *  日本年金機構「賃金要件の撤廃（2026年10月1日）」「被扶養者認定の年間収入（令和8年4月〜労働契約で判定）」、国民年金保険料 令和8年度 月17,920円。検証日 2026-10-19 */
  const KABE = {
    fuyoShotoku: 620000,       // 同一生計配偶者・扶養親族の合計所得要件（令和8年分〜）
    shotokuzeiLine: 1780000,   // 本人に所得税がかからない給与収入（基礎控除104万＋給与所得控除74万）
    fuyoHoken: 1300000, fuyoHokenGakusei: 1500000, fuyoHokenSenior: 1800000, // 健康保険の被扶養者（未満）
    kokunenMonthly: 17920,
    // 配偶者特別控除（所得税）: [配偶者の合計所得の上限, 控除額（扶養者の合計所得900万以下）]
    haiTokubetsu: [[950000, 380000], [1000000, 360000], [1050000, 310000], [1100000, 260000], [1150000, 210000], [1200000, 160000], [1250000, 110000], [1300000, 60000], [1330000, 30000]],
    // 特定親族特別控除（所得税）
    tokuteiShinzoku: [[850000, 630000], [900000, 610000], [950000, 510000], [1000000, 410000], [1050000, 310000], [1100000, 210000], [1150000, 110000], [1200000, 60000], [1230000, 30000]]
  };
  // 扶養者の合計所得による配偶者控除・配偶者特別控除の逓減（900万以下 / 950万以下 / 1,000万以下）
  const haiTier = (amt, earnerGoukei) => earnerGoukei <= 9000000 ? amt : earnerGoukei <= 9500000 ? Math.ceil(amt * 2 / 3 / 10000) * 10000 : earnerGoukei <= 10000000 ? Math.ceil(amt / 3 / 10000) * 10000 : 0;
  const lookup = (tbl, v) => { for (const [lim, amt] of tbl) if (v <= lim) return amt; return 0; };
  /** 扶養者が受けられる所得税の控除（relation: spouse | tokutei(19〜22歳) | ippan） */
  function kabeKojo(relation, income, earnerIncome) {
    const g = kyuyoShotoku(income), eg = kyuyoShotoku(earnerIncome);
    if (relation === 'spouse') {
      if (eg > 10000000) return { name: '控除なし（扶養者の合計所得1,000万円超）', amount: 0, max: 0 };
      const max = haiTier(380000, eg);
      if (g <= KABE.fuyoShotoku) return { name: '配偶者控除', amount: max, max };
      const t = lookup(KABE.haiTokubetsu, g);
      return { name: t ? '配偶者特別控除' : '控除なし', amount: haiTier(t, eg), max };
    }
    if (relation === 'tokutei') {
      if (g <= KABE.fuyoShotoku) return { name: '特定扶養控除', amount: 630000, max: 630000 };
      const t = lookup(KABE.tokuteiShinzoku, g);
      return { name: t ? '特定親族特別控除' : '控除なし', amount: t, max: 630000 };
    }
    return g <= KABE.fuyoShotoku ? { name: '扶養控除', amount: 380000, max: 380000 } : { name: '控除なし', amount: 0, max: 380000 };
  }
  function calcKabe(opt) {
    const income = Math.max(0, Math.floor(opt.income || 0));
    const relation = opt.relation === 'tokutei' || opt.relation === 'ippan' ? opt.relation : 'spouse';
    const age = clamp(Math.floor(opt.age || (relation === 'tokutei' ? 20 : 40)), 15, 90);
    const earner = Math.max(0, Math.floor(opt.earner != null ? opt.earner : 5000000));
    const kyuchi = JUMIN.kyuchi[opt.kyuchi] ? +opt.kyuchi : 1;
    const kokuho = Math.max(0, Math.floor(opt.kokuho || 0));
    const kyuyo = kyuyoShotoku(income);
    // 社会保険: 週20時間以上・従業員51人以上（2027年10月〜36人以上）・学生でない → 年収にかかわらず加入（賃金要件は2026年10月撤廃）
    const shahoJoin = !!opt.week20 && !!opt.large && !opt.student;
    const fuyoLimit = age >= 60 || opt.disability ? KABE.fuyoHokenSenior : relation === 'tokutei' ? KABE.fuyoHokenGakusei : KABE.fuyoHoken;
    const fuyoIn = !shahoJoin && income < fuyoLimit;                    // 健康保険の扶養に入れる（同一世帯で扶養者の年収の1/2未満も必要）
    const nenkinAge = age >= 20 && age < 60;
    const kokunen = KABE.kokunenMonthly * 12;
    const empShaho = calcTedori({ income, age }).shaho;
    let shaho, shahoLabel;
    if (shahoJoin) { shaho = empShaho; shahoLabel = '勤務先の社会保険（健康保険・厚生年金）'; }
    else if (fuyoIn) {
      shaho = relation !== 'spouse' && nenkinAge ? kokunen : 0;          // 配偶者は第3号、子・親族は20歳以上なら国民年金
      shahoLabel = relation === 'spouse' ? '扶養内（第3号被保険者・保険料負担なし）' : nenkinAge ? '健康保険は扶養内・国民年金は本人負担' : '扶養内（保険料負担なし）';
    } else if (opt.after === 'kokuho') { shaho = (nenkinAge ? kokunen : 0) + kokuho; shahoLabel = '国民年金＋国民健康保険' + (kokuho ? '' : '（国保料は未入力）'); }
    else { shaho = empShaho; shahoLabel = '勤務先の社会保険に加入（扶養を外れた後）'; }
    // 本人の税
    const kazeiS = floor1000(Math.max(0, kyuyo - shaho - kisoKojoShotoku(kyuyo)));
    const shotokuzei = incomeTax(kazeiS);
    const juminzei = calcJuminzei({ income, age, shaho, kyuchi }).total;
    const tedori = income - shaho - shotokuzei - juminzei;
    // 扶養者の控除と増税（所得税のみ。住民税も同様に減る）
    const kojo = kabeKojo(relation, income, earner);
    const earnerRate = incomeTaxRate(calcTedori({ income: earner, age: 40 }).kazeiS);
    const earnerTaxUp = Math.floor((kojo.max - kojo.amount) * earnerRate * RATES.fukko);
    const household = tedori - earnerTaxUp;
    return {
      income, relation, age, earner, kyuchi, kyuyo, shahoJoin, fuyoLimit, fuyoIn, shaho, shahoLabel, empShaho, kokunen,
      kazeiS, shotokuzei, juminzei, tedori, kojo, earnerRate, earnerTaxUp, household,
      juminLine: juminHikazeiIncome({ kyuchi }, 'kinto')
    };
  }
  /** 扶養を外れた直後の手取り減を取り戻せる年収（なければ 0） */
  function kabeBreakEven(opt) {
    const base = calcKabe(Object.assign({}, opt, { income: 0 }));
    if (base.shahoJoin) return 0;
    const below = calcKabe(Object.assign({}, opt, { income: base.fuyoLimit - 1000 })).household;
    for (let x = base.fuyoLimit; x <= 4000000; x += 1000) if (calcKabe(Object.assign({}, opt, { income: x })).household >= below) return x;
    return 0;
  }

  /** iDeCo 節税シミュレーター（2026年12月施行の拠出限度額）
   *  根拠: 厚生労働省「iDeCoの拠出限度額の引上げ等（令和8年12月1日施行）」、国民年金基金連合会 手数料改定（令和8年12月分〜 月105円→120円）、
   *  所得税法75条（小規模企業共済等掛金控除・全額）、退職所得控除（所得税法30条）。検証日 2026-10-26 */
  const IDECO = {
    min: 5000,                  // 掛金の下限（月額、1,000円単位）
    kyosai: 8000,               // 公務員（国家・地方公務員共済）の共済掛金相当額
    feeJoin: 2829, feeMonthly: 186, // 加入時手数料、口座管理手数料（連合会120円＋事務委託先66円、運営管理機関0円の場合）
    // kind: [改正後の限度額, 改正前の限度額]（企業年金等ありは掛金相当額を差し引く）
    kinds: {
      nashi: { label: '会社員（企業年金なし）', limit: 62000, old: 23000 },
      corp: { label: '会社員（企業型DC・DBなどあり）', limit: 62000, old: 55000 },
      koumuin: { label: '公務員', limit: 62000, old: 55000 },
      jiei: { label: '自営業・フリーランス（第1号）', limit: 75000, old: 68000 },
      shufu: { label: '専業主婦・主夫（第3号）', limit: 23000, old: 23000 }
    }
  };
  const floorK = (n) => Math.floor(n / 1000) * 1000;
  /** 月額の拠出限度額（改正後・改正前）。5,000円未満なら拠出できないため 0 */
  function idecoLimit(kind, corp) {
    const k = IDECO.kinds[kind] ? kind : 'nashi';
    const c = k === 'koumuin' ? IDECO.kyosai : k === 'corp' ? Math.max(0, Math.floor(corp || 0)) : 0;
    let limit = IDECO.kinds[k].limit - c, old = IDECO.kinds[k].old - c;
    if (k === 'corp' || k === 'koumuin') old = Math.min(20000, old);
    limit = floorK(limit); old = floorK(old);
    return { kind: k, corp: c, limit: limit >= IDECO.min ? limit : 0, old: old >= IDECO.min ? old : 0 };
  }
  /** 所得控除 ideco を差し引いたときの所得税・住民税所得割（goukei: 合計所得金額） */
  function idecoTax(goukei, shaho, dep, ideco) {
    const kazeiS = floor1000(Math.max(0, goukei - shaho - kisoKojoShotoku(goukei) - dep * 380000 - ideco));
    const shotokuzei = incomeTax(kazeiS);
    let jumin = 0;
    const line = dep > 0 ? 350000 * (dep + 1) + 420000 : 450000;        // 所得割の非課税限度額（総所得金額等）
    if (goukei > line) {
      const kazeiJ = floor1000(Math.max(0, goukei - shaho - kisoKojoJumin(goukei) - dep * 330000 - ideco));
      jumin = floor100(Math.max(0, floor100(kazeiJ * RATES.juminRate) - chouseiKojo(kazeiJ, 50000 + dep * 50000)));
    }
    return { kazeiS, shotokuzei, jumin, rate: incomeTaxRate(kazeiS) };
  }
  function calcIdeco(opt) {
    const lim = idecoLimit(opt.kind, opt.corp);
    const kind = lim.kind;
    const income = Math.max(0, Math.floor(opt.income || 0));
    const age = clamp(Math.floor(opt.age || 30), 18, 69);
    const dep = clamp(Math.floor(opt.dependents || 0), 0, 20);
    const want = Math.max(0, Math.floor(opt.monthly || 0));
    const monthly = Math.min(floorK(want), lim.limit);
    const capped = floorK(want) > lim.limit;
    const tooSmall = monthly > 0 && monthly < IDECO.min;
    const contrib = tooSmall ? 0 : monthly;
    const annual = contrib * 12;
    const years = clamp(Math.floor(opt.years || 0), 1, 50);
    // 所得: 自営業は所得（売上−経費・青色申告特別控除後）を入力、それ以外は給与収入
    const goukei = kind === 'jiei' ? income : kyuyoShotoku(income);
    let shaho;
    if (opt.shaho != null && opt.shaho !== '' && +opt.shaho >= 0) shaho = Math.floor(+opt.shaho);
    else if (kind === 'jiei') shaho = 17920 * 12;                      // 国民年金のみ（国保料は入力値）
    else if (kind === 'shufu') shaho = 0;
    else shaho = calcTedori({ income, age }).shaho;
    const before = idecoTax(goukei, shaho, dep, 0), after = idecoTax(goukei, shaho, dep, annual);
    const saveS = before.shotokuzei - after.shotokuzei, saveJ = before.jumin - after.jumin, saveYear = saveS + saveJ;
    const ts = calcTsumitate({ monthly: contrib, rate: opt.rate || 0, years });
    const receive = calcTaishokukin({ amount: Math.max(0, Math.floor(ts.final)), years });
    const receiveTax = contrib ? receive.shotokuzei + receive.juminzei : 0;
    const gainTax = ts.gain > 0 && contrib ? Math.floor(ts.gain * 0.20315) : 0; // 課税口座なら運用益にかかる税
    const fees = contrib ? IDECO.feeJoin + IDECO.feeMonthly * 12 * years : 0;
    const saveTotal = saveYear * years;
    return {
      kind, label: IDECO.kinds[kind].label, limit: lim.limit, oldLimit: lim.old, corp: lim.corp,
      income, age, dep, goukei, shaho, monthly: contrib, want, capped, tooSmall, annual, years,
      before, after, saveS, saveJ, saveYear, saveRate: annual ? saveYear / annual : 0, saveTotal,
      final: contrib ? ts.final : 0, paid: contrib ? ts.paid : 0, gain: contrib ? ts.gain : 0, series: ts.series,
      kojo: receive.kojo, receiveTax, gainTax, fees,
      net: saveTotal + gainTax - receiveTax - fees,
      endAge: age + years
    };
  }

  // ---------- SVG 折れ線チャート ----------
  function lineChart(seriesList, opt) {
    const W = 640, H = 300, pl = 56, pr = 16, pt = 16, pb = 32;
    const n = Math.max(...seriesList.map(s => s.length));
    const maxV = Math.max(1, ...seriesList.flat());
    const xs = (i) => pl + (W - pl - pr) * (n > 1 ? i / (n - 1) : 0);
    const ys = (v) => pt + (H - pt - pb) * (1 - v / maxV);
    const fmtY = (v) => v >= 1e8 ? (v / 1e8).toFixed(1) + '億' : Math.round(v / 1e4).toLocaleString('ja-JP') + '万';
    let g = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${opt.label || ''}">`;
    const ticks = 5;
    for (let t = 0; t <= ticks; t++) {
      const v = maxV * t / ticks, y = ys(v);
      g += `<line class="axis" x1="${pl}" y1="${y.toFixed(1)}" x2="${W - pr}" y2="${y.toFixed(1)}"/><text x="${pl - 6}" y="${(y + 4).toFixed(1)}" text-anchor="end">${fmtY(v)}</text>`;
    }
    const xStep = Math.max(1, Math.ceil((n - 1) / 10 / (opt.xUnit || 1)) * (opt.xUnit || 1));
    for (let i = 0; i < n; i += xStep) g += `<text x="${xs(i).toFixed(1)}" y="${H - 10}" text-anchor="middle">${opt.xLabel ? opt.xLabel(i) : i}</text>`;
    seriesList.forEach((s, idx) => {
      const pts = s.map((v, i) => `${xs(i).toFixed(1)},${ys(v).toFixed(1)}`).join(' ');
      if (idx === 0) g += `<polygon class="a1" points="${xs(0)},${ys(0)} ${pts} ${xs(s.length - 1)},${ys(0)}"/>`;
      g += `<polyline class="l${idx + 1}" points="${pts}"/>`;
    });
    return g + '</svg>';
  }

  // ---------- DOM ヘルパー ----------
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $out = (sel, root) => $(sel, root) || document.querySelector(sel); // ツール枠の外にある表・グラフ用
  const num = (el) => { const v = parseFloat(String(el.value).replace(/[,，]/g, '')); return isNaN(v) ? 0 : v; };
  const kvRows = (rows) => `<div class="kv">${rows.map(([k, v, cls]) => `<div>${k}</div><div class="${cls || ''}">${v}</div>`).join('')}</div>`;
  function bindLive(root, fn) {
    root.querySelectorAll('input,select').forEach(el => el.addEventListener('input', fn));
    root.querySelectorAll('input,select').forEach(el => el.addEventListener('change', fn));
    const btn = $('.btn-calc', root); if (btn) btn.addEventListener('click', (e) => { e.preventDefault(); fn(); });
    const form = $('form', root); if (form) form.addEventListener('submit', (e) => { e.preventDefault(); fn(); });
    fn();
  }

  // ---------- 各ツールの初期化 ----------
  const TOOLS = {};

  TOOLS.tedori = function (root) {
    const out = $('.result', root), tbl = $out('[data-quick]', root);
    bindLive(root, () => {
      const income = num($('[name=income]', root)) * 10000;
      const age = num($('[name=age]', root)) || 30;
      const dependents = num($('[name=dependents]', root));
      const r = calcTedori({ income, age, dependents });
      if (income <= 0) { out.classList.add('is-empty'); out.innerHTML = '<div class="big">年収を入力してください</div>'; return; }
      out.classList.remove('is-empty');
      out.innerHTML = `<div class="sub">年収 ${yen(income)}円（${man(income)}万円）の手取り額（概算）</div>
<div class="big">約 ${yen(r.tedori)} 円 <span class="sub">／年</span></div>
<div class="sub">月あたり約 ${yen(r.tedoriMonthly)} 円（手取り率 ${(r.rate * 100).toFixed(1)}%）</div>
${kvRows([
        ['健康保険料（東京 9.85%・折半）', yen(r.kenpo) + ' 円', 'neg'],
        ['子ども・子育て支援金（0.23%・折半）', yen(r.shienkin) + ' 円', 'neg'],
        ['介護保険料（40〜64歳 1.62%・折半）', (r.kaigo ? yen(r.kaigo) + ' 円' : '対象外'), r.kaigo ? 'neg' : ''],
        ['厚生年金保険料（18.3%・折半）', yen(r.kosei) + ' 円', 'neg'],
        ['雇用保険料（0.5%）', yen(r.koyo) + ' 円', 'neg'],
        ['社会保険料 合計', yen(r.shaho) + ' 円', 'neg'],
        ['所得税（復興特別所得税込み）', yen(r.shotokuzei) + ' 円', 'neg'],
        ['住民税（所得割＋均等割）', yen(r.juminzei) + ' 円', 'neg'],
        ['天引き合計', yen(r.shaho + r.shotokuzei + r.juminzei) + ' 円', 'neg'],
        ['手取り（年）', yen(r.tedori) + ' 円']
      ])}
<p class="note">内訳メモ: 給与所得 ${yen(r.kyuyo)}円 ／ 基礎控除（所得税）${yen(r.kisoS)}円 ／ 課税所得（所得税）${yen(r.kazeiS)}円（税率 ${(r.taxRate * 100)}%）／ 課税所得（住民税）${yen(r.kazeiJ)}円 ／ 標準報酬月額 ${yen(r.smrK)}円（厚生年金 ${yen(r.smrP)}円）</p>`;
      if (tbl) {
        let rows = '';
        for (let m = 300; m <= 1500; m += 100) {
          const q = calcTedori({ income: m * 10000, age, dependents });
          const hl = Math.round(income / 10000) === m ? ' class="hl"' : '';
          rows += `<tr${hl}><td class="num">${m.toLocaleString('ja-JP')}万円</td><td class="num">${yen(q.shaho)}</td><td class="num">${yen(q.shotokuzei)}</td><td class="num">${yen(q.juminzei)}</td><td class="num">${yen(q.tedori)}</td><td class="num">${yen(q.tedoriMonthly)}</td><td class="num">${(q.rate * 100).toFixed(1)}%</td></tr>`;
        }
        tbl.innerHTML = rows;
        const cap = $out('[data-quick-caption]', root);
        if (cap) cap.textContent = `条件: ${age}歳・扶養${dependents}人（入力に連動して再計算しています）`;
      }
    });
  };

  TOOLS.loan = function (root) {
    const out = $('.result', root), tbl = $out('[data-yearly]', root), chart = $out('[data-chart]', root), pre = $out('[data-prepay]', root);
    bindLive(root, () => {
      const principal = num($('[name=principal]', root)) * 10000;
      const r = calcLoan({
        principal, rate: num($('[name=rate]', root)), years: num($('[name=years]', root)),
        type: ($('[name=type]:checked', root) || {}).value,
        bonusPrincipal: num($('[name=bonus]', root)) * 10000,
        prepay: num($('[name=prepay]', root)) * 10000, prepayYear: num($('[name=prepayYear]', root))
      });
      if (principal <= 0) { out.classList.add('is-empty'); out.innerHTML = '<div class="big">借入額を入力してください</div>'; return; }
      out.classList.remove('is-empty');
      const typeName = r.type === 'ganri' ? '元利均等' : '元金均等';
      out.innerHTML = `<div class="sub">借入 ${man(r.principal)}万円・年${r.rate}%・${r.years}年・${typeName}${r.bonusPrincipal ? `・ボーナス返済分 ${man(r.bonusPrincipal)}万円` : ''}</div>
<div class="big">毎月 ${yen(r.monthlyPay)} 円${r.type === 'gankin' ? ' <span class="sub">（初回。最終回は約 ' + yen(r.monthlyPayLast) + ' 円）</span>' : ''}</div>
${r.bonusPrincipal ? `<div class="sub">ボーナス月は＋${yen(r.bonusPay)} 円（年2回）</div>` : ''}
${kvRows([
        ['総返済額', yen(r.totalPay) + ' 円'],
        ['うち利息', yen(r.totalInt) + ' 円', 'neg'],
        ['年間返済額（1年目）', yen(r.yearly[0] ? r.yearly[0].pay : 0) + ' 円'],
        ['借入額に対する利息の割合', (r.principal ? (r.totalInt / r.principal * 100).toFixed(1) : 0) + ' %']
      ])}`;
      if (pre) {
        if (r.prepay) {
          const yrs = Math.floor(r.prepay.monthsSaved / 12), mos = r.prepay.monthsSaved % 12;
          pre.innerHTML = `<h3>繰上返済（期間短縮型）の効果</h3>${kvRows([
            [`${r.prepay.year}年目末に ${man(r.prepay.amount)}万円を繰上返済`, ''],
            ['短縮される期間', `${yrs}年${mos}か月`],
            ['軽減される利息', yen(r.prepay.interestSaved) + ' 円'],
            ['完済までの期間', `${Math.floor(r.prepay.endMonths / 12)}年${r.prepay.endMonths % 12}か月`]
          ])}<p class="note">月々の返済額は変えず、残りの期間を短くする前提です。繰上返済分は元金に充当されます。</p>`;
        } else pre.innerHTML = '';
      }
      if (chart) {
        const step = 12;
        const s1 = r.baseBalances.filter((_, i) => i % step === step - 1); s1.unshift(r.principal - r.bonusPrincipal);
        const list = [s1];
        if (r.prepay) { const s2 = r.balances.filter((_, i) => i % step === step - 1); s2.unshift(r.principal - r.bonusPrincipal); while (s2.length < s1.length) s2.push(0); list.push(s2); }
        chart.innerHTML = lineChart(list, { label: 'ローン残高の推移', xLabel: i => i + '年' }) + `<div class="legend"><span><i class="c1"></i>残高（月払い分）</span>${r.prepay ? '<span><i class="c2"></i>繰上返済あり</span>' : ''}</div>`;
      }
      if (tbl) tbl.innerHTML = r.yearly.map(y => `<tr><td class="num">${y.year}年目</td><td class="num">${yen(y.pay)}</td><td class="num">${yen(y.interest)}</td><td class="num">${yen(y.pay - y.interest)}</td><td class="num">${yen(y.bal)}</td></tr>`).join('');
    });
  };

  TOOLS.furusato = function (root) {
    const out = $('.result', root), tbl = $out('[data-quick]', root);
    bindLive(root, () => {
      const income = num($('[name=income]', root)) * 10000;
      const family = ($('[name=family]:checked', root) || {}).value || 'single';
      const hs = num($('[name=hs]', root)), univ = num($('[name=univ]', root));
      const r = calcFurusato({ income, family, highschool: hs, university: univ });
      if (income <= 0) { out.classList.add('is-empty'); out.innerHTML = '<div class="big">年収を入力してください</div>'; return; }
      out.classList.remove('is-empty');
      out.innerHTML = `<div class="sub">年収 ${man(income)}万円・${{ single: '独身または共働き', dual: '共働き', spouse: '配偶者を扶養' }[family]}${hs ? `・高校生${hs}人` : ''}${univ ? `・大学生${univ}人` : ''}</div>
<div class="big">上限の目安 約 ${yen(r.limitFloor)} 円</div>
<div class="sub">この金額までの寄附なら自己負担は実質2,000円（概算）</div>
${kvRows([
        ['住民税所得割額（調整控除後の概算）', yen(r.shotokuwari) + ' 円'],
        ['適用される所得税率', (r.rate * 100) + ' %'],
        ['社会保険料（概算・控除に使用）', yen(r.shaho) + ' 円'],
        ['課税所得（所得税／住民税）', `${yen(r.kazeiS)} / ${yen(r.kazeiJ)} 円`],
        ['計算式', `${yen(r.shotokuwari)}×20%÷(90%−${(r.rate * 100)}%×1.021)＋2,000`]
      ])}
<p class="note">余裕をみて上限の9割程度に抑えると安心です。住宅ローン控除・医療費控除・iDeCo などがある方は上限が下がります。</p>`;
      if (tbl) {
        let rows = '';
        for (let m = 300; m <= 1500; m += 100) {
          const a = calcFurusato({ income: m * 10000, family: 'single' }).limitFloor;
          const b = calcFurusato({ income: m * 10000, family: 'spouse' }).limitFloor;
          const c = calcFurusato({ income: m * 10000, family: 'single', highschool: 1 }).limitFloor;
          const d = calcFurusato({ income: m * 10000, family: 'spouse', university: 1 }).limitFloor;
          const hl = Math.round(income / 10000) === m ? ' class="hl"' : '';
          rows += `<tr${hl}><td class="num">${m.toLocaleString('ja-JP')}万円</td><td class="num">${yen(a)}</td><td class="num">${yen(b)}</td><td class="num">${yen(c)}</td><td class="num">${yen(d)}</td></tr>`;
        }
        tbl.innerHTML = rows;
      }
    });
  };

  TOOLS.tsumitate = function (root) {
    const out = $('.result', root), chart = $out('[data-chart]', root), tbl = $out('[data-yearly]', root), rev = $out('[data-reverse]', root), wd = $out('[data-withdraw]', root);
    bindLive(root, () => {
      const r = calcTsumitate({
        monthly: num($('[name=monthly]', root)) * 10000, initial: num($('[name=initial]', root)) * 10000,
        rate: num($('[name=rate]', root)), years: num($('[name=years]', root)),
        target: num($('[name=target]', root)) * 10000, withdrawRate: num($('[name=wrate]', root)) || 4,
        withdrawReturn: num($('[name=wreturn]', root))
      });
      if (r.monthly <= 0 && r.initial <= 0) { out.classList.add('is-empty'); out.innerHTML = '<div class="big">毎月の積立額を入力してください</div>'; return; }
      out.classList.remove('is-empty');
      out.innerHTML = `<div class="sub">毎月 ${man(r.monthly)}万円${r.initial ? `＋初期 ${man(r.initial)}万円` : ''}・年利 ${r.rate}%・${r.years}年</div>
<div class="big">${r.years}年後 約 ${yen(r.final)} 円</div>
<div class="sub">元本 ${yen(r.paid)} 円 ＋ 運用益 ${yen(r.gain)} 円（税引前・手数料考慮なし）</div>
${kvRows([
        ['積立元本の合計', yen(r.paid) + ' 円'],
        ['運用益（複利）', yen(r.gain) + ' 円'],
        ['最終資産', yen(r.final) + ' 円'],
        ['運用益にかかる税の目安（20.315%・課税口座の場合）', yen(r.gain > 0 ? r.gain * 0.20315 : 0) + ' 円', 'neg'],
        ['新NISAつみたて投資枠（年120万）で足りる？', r.monthly * 12 <= 1200000 ? 'はい（月10万円以内）' : r.monthly * 12 <= 3600000 ? '成長投資枠と併用で可（年360万円以内）' : '年360万円を超えます'],
        ['生涯投資枠1,800万円に達するまで', r.monthly > 0 ? `約${r.nisaYears}年` : '—']
      ])}`;
      if (rev) rev.innerHTML = r.target > 0 ? `<h3>目標額から逆算</h3>${kvRows([
        [`目標 ${man(r.target)}万円 を ${r.years}年・年利${r.rate}% で達成するには`, ''],
        ['必要な毎月の積立額', yen(r.needMonthly) + ' 円'],
        ['今の積立額との差', (r.needMonthly - r.monthly >= 0 ? '＋' : '−') + yen(Math.abs(r.needMonthly - r.monthly)) + ' 円／月']
      ])}` : '';
      if (wd) wd.innerHTML = `<h3>取り崩しシミュレーション（${(num($('[name=wrate]', root)) || 4)}%ルール）</h3>${kvRows([
        ['取り崩し開始時の資産', yen(r.final) + ' 円'],
        ['年間の取り崩し額（初年度資産×率, 定額）', yen(r.withdrawAnnual) + ' 円'],
        ['月あたり', yen(r.withdrawMonthly) + ' 円'],
        ['資産が尽きるまで', r.withdrawYears === Infinity ? '100年以上（理論上は減らない）' : `約${r.withdrawYears}年`]
      ])}<p class="note">取り崩し中の利回りは「取り崩し中の想定利回り」欄の値で計算しています。相場の変動（特に取り崩し初期の下落）は考慮していません。</p>`;
      if (chart) chart.innerHTML = lineChart([r.series.map(s => s.bal), r.series.map(s => s.paid)], { label: '資産推移', xLabel: i => i + '年' }) + '<div class="legend"><span><i class="c1"></i>資産額</span><span><i class="c2"></i>積立元本</span></div>';
      if (tbl) tbl.innerHTML = r.series.filter(s => s.year > 0 && (s.year % (r.years > 30 ? 5 : r.years > 15 ? 2 : 1) === 0 || s.year === r.years)).map(s => `<tr><td class="num">${s.year}年後</td><td class="num">${yen(s.paid)}</td><td class="num">${yen(s.bal - s.paid)}</td><td class="num">${yen(s.bal)}</td></tr>`).join('');
    });
  };

  TOOLS.taishokukin = function (root) {
    const out = $('.result', root), tbl = $out('[data-quick]', root);
    bindLive(root, () => {
      const amount = num($('[name=amount]', root)) * 10000;
      const years = num($('[name=years]', root));
      const officer = !!($('[name=officer]', root) && $('[name=officer]', root).checked);
      const r = calcTaishokukin({ amount, years, officer });
      if (amount <= 0) { out.classList.add('is-empty'); out.innerHTML = '<div class="big">退職金額を入力してください</div>'; return; }
      out.classList.remove('is-empty');
      out.innerHTML = `<div class="sub">退職金 ${man(amount)}万円・勤続${r.years}年${officer ? '・役員等' : ''}</div>
<div class="big">手取り 約 ${yen(r.tedori)} 円</div>
<div class="sub">税負担 ${yen(r.shotokuzei + r.juminzei)} 円（実効 ${(r.rate * 100).toFixed(2)}%）</div>
${kvRows([
        ['退職所得控除額', yen(r.kojo) + ' 円'],
        ['控除後の金額', yen(r.excess) + ' 円'],
        ['課税退職所得金額（原則 1/2）', yen(r.kazei) + ' 円'],
        [`所得税（税率${r.taxRate * 100}%・復興特別所得税込み）`, yen(r.shotokuzei) + ' 円', 'neg'],
        ['住民税（10%）', yen(r.juminzei) + ' 円', 'neg'],
        ['手取り額', yen(r.tedori) + ' 円']
      ])}`;
      if (tbl) {
        let rows = '';
        for (const amt of [500, 1000, 1500, 2000, 2500, 3000]) {
          rows += `<tr><td class="num">${amt.toLocaleString('ja-JP')}万円</td>` + [10, 20, 30, 38].map(y => `<td class="num">${yen(calcTaishokukin({ amount: amt * 10000, years: y }).tedori)}</td>`).join('') + '</tr>';
        }
        tbl.innerHTML = rows;
      }
    });
  };

  TOOLS.shitsugyo = function (root) {
    const out = $('.result', root), tbl = $out('[data-quick]', root);
    bindLive(root, () => {
      const salary = num($('[name=salary]', root)) * 10000;
      const age = num($('[name=age]', root)) || 35;
      const years = num($('[name=years]', root));
      const reason = ($('[name=reason]:checked', root) || {}).value || 'ippan';
      const r = calcShitsugyo({ salary, age, years, reason });
      if (salary <= 0) { out.classList.add('is-empty'); out.innerHTML = '<div class="big">離職前の平均月給を入力してください</div>'; return; }
      out.classList.remove('is-empty');
      const reasonName = { ippan: '自己都合など（一般の受給資格者）', tokutei: '会社都合・倒産・解雇など（特定受給資格者）', konnan: '就職困難者' }[r.reason];
      const title = r.senior ? '高年齢求職者給付金の日額' : '基本手当日額';
      const eligNote = r.eligible ? '' : `<p class="note">被保険者期間が${r.reason === 'ippan' ? '12か月（離職前2年間）' : '6か月（離職前1年間）'}に満たないため、原則として受給資格がありません。期間の数え方（月11日以上の月を数える等）はハローワークでご確認ください。</p>`;
      out.innerHTML = `<div class="sub">月給 ${man(salary)}万円・${r.age}歳・被保険者期間 ${r.years}年・${r.senior ? '65歳以上' : reasonName}</div>
<div class="big">${title} 約 ${yen(r.daily)} 円 <span class="sub">／日</span></div>
<div class="sub">${r.eligible ? `所定給付日数 ${r.days}日 → 受給総額の目安 約 ${yen(r.total)} 円` : '受給資格の要件を満たしていない可能性があります'}</div>
${kvRows([
        ['賃金日額（月給×6÷180）', yen(r.w) + ' 円' + (r.capped ? `（上限 ${yen(r.wUsed)} 円を適用）` : r.floored ? `（下限 ${yen(r.wUsed)} 円を適用）` : '')],
        ['年齢区分', r.senior ? '65歳以上（日額は29歳以下と同じ式）' : r.bracket],
        ['給付率（日額÷賃金日額）', (r.rate * 100).toFixed(1) + ' %'],
        [title, yen(r.daily) + ' 円'],
        ['所定給付日数', r.eligible ? r.days + ' 日' : '—'],
        ['1回（28日分）の支給額の目安', r.senior ? '一時金として1回で支給' : yen(r.per28) + ' 円'],
        ['受給総額の目安', yen(r.total) + ' 円'],
        ['待期・給付制限', r.senior ? '待期7日' : `待期7日${r.restrictionMonths ? `＋給付制限 原則${r.restrictionMonths}か月` : '（給付制限なし）'}`]
      ])}
${eligNote}<p class="note">基本手当日額の上限（令和8年8月1日〜）: 29歳以下 7,450円／30〜44歳 8,270円／45〜59歳 9,110円／60〜64歳 7,830円。下限 2,562円。実際の支給額は離職票の賃金額・離職理由に基づきハローワークが決定します。</p>`;
      if (tbl) {
        let rows = '';
        for (const m of [15, 20, 25, 30, 35, 40, 45, 50, 60]) {
          const w = Math.floor(m * 10000 / 30);
          const hl = Math.round(salary / 10000) === m ? ' class="hl"' : '';
          rows += `<tr${hl}><td class="num">${m}万円</td><td class="num">${yen(w)}</td>` + [25, 35, 50, 62].map(a => `<td class="num">${yen(kihonTeate(w, a))}</td>`).join('') + '</tr>';
        }
        tbl.innerHTML = rows;
      }
    });
  };

  TOOLS.zangyo = function (root) {
    const out = $('.result', root), tbl = $out('[data-quick]', root), fx = $out('[data-fixed]', root);
    bindLive(root, () => {
      const salary = num($('[name=salary]', root)) * 10000;
      const r = calcZangyo({
        salary, excluded: num($('[name=excluded]', root)),
        dayHours: num($('[name=dayHours]', root)) || 8, holidays: num($('[name=holidays]', root)),
        overtime: num($('[name=overtime]', root)), night: num($('[name=night]', root)),
        holiday: num($('[name=holiday]', root)), holidayNight: num($('[name=holidayNight]', root)),
        fixedAmount: num($('[name=fixedAmount]', root)), fixedHours: num($('[name=fixedHours]', root))
      });
      if (salary <= 0) { out.classList.add('is-empty'); out.innerHTML = '<div class="big">月給を入力してください</div>'; if (fx) fx.innerHTML = ''; return; }
      out.classList.remove('is-empty');
      const hoursTxt = (h) => (Math.round(h * 10) / 10).toLocaleString('ja-JP');
      out.innerHTML = `<div class="sub">月給 ${man(salary)}万円（除外手当 ${yen(r.excluded)}円）・月平均所定労働時間 ${hoursTxt(r.monthlyHours)}時間・残業 ${hoursTxt(r.overtime)}時間${r.night ? `（うち深夜${hoursTxt(r.night)}時間）` : ''}${r.holiday ? `・休日労働 ${hoursTxt(r.holiday)}時間` : ''}</div>
<div class="big">残業代の目安 約 ${yen(r.total)} 円 <span class="sub">／月</span></div>
<div class="sub">1時間あたりの基礎賃金 ${yen(r.hourly)} 円 → 残業1時間 ${yen(r.otHourly25)} 円（25%増）${r.ot50h ? `／60時間超 ${yen(r.otHourly50)} 円（50%増）` : ''}</div>
${kvRows([
        ['基礎賃金（月給−除外手当）÷月平均所定労働時間', `${yen(r.basis)}円 ÷ ${hoursTxt(r.monthlyHours)}h ＝ ${yen(r.hourly)} 円`],
        [`時間外（60時間まで ${hoursTxt(r.ot25h)}h × ${yen(r.otHourly25)}円）`, yen(r.ot25) + ' 円'],
        [`時間外（60時間超 ${hoursTxt(r.ot50h)}h × ${yen(r.otHourly50)}円）`, r.ot50h ? yen(r.ot50) + ' 円' : '—'],
        [`深夜割増（${hoursTxt(r.night + r.holidayNight)}h × ${yen(round50(r.hourly * 0.25))}円）`, r.night + r.holidayNight ? yen(r.nightPay + r.holidayNightPay) + ' 円' : '—'],
        [`法定休日労働（${hoursTxt(r.holiday)}h × ${yen(r.holidayHourly)}円・35%増）`, r.holiday ? yen(r.holidayPay) + ' 円' : '—'],
        ['残業代 合計（月）', yen(r.total) + ' 円'],
        ['残業代込みの月収（額面）', yen(r.monthlyTotal) + ' 円'],
        ['同じ残業が1年続いた場合', yen(r.annual) + ' 円'],
        ['3年分（未払い賃金の請求期間の目安）', yen(r.threeYears) + ' 円']
      ])}
<p class="note">端数は通達にならい1時間あたり賃金・各割増額で50銭未満切捨て・50銭以上切上げ。残業時間は1分単位で集計するのが原則です（月合計の30分未満切捨て・30分以上切上げのみ可）。</p>`;
      if (fx) {
        if (r.fixedAmount > 0 || r.fixedHours > 0) {
          const rows = [];
          if (r.fixedAmount > 0) rows.push(['固定残業代（月額）', yen(r.fixedAmount) + ' 円']);
          if (r.fixedAmount > 0) rows.push(['法定の単価（基礎賃金×1.25）で割ると何時間分？', `約 ${hoursTxt(r.fixedImpliedHours)} 時間分`]);
          if (r.fixedHours > 0) rows.push(['契約上の固定残業時間', hoursTxt(r.fixedHours) + ' 時間']);
          if (r.fixedPerHour > 0) rows.push(['固定残業代の1時間あたり単価（金額÷時間数）', `${yen(r.fixedPerHour)} 円（法定 ${yen(r.otHourly25)} 円）`, r.fixedUnderLegal ? 'neg' : '']);
          if (r.fixedAmount > 0) rows.push(['今月の法定計算額との差額（追加で支払われるべき目安）', r.shortage > 0 ? yen(r.shortage) + ' 円' : '0 円（固定残業代の範囲内）', r.shortage > 0 ? 'neg' : '']);
          if (r.fixedHours > 0) rows.push(['固定残業時間を超えた残業', r.overFixedHours > 0 ? hoursTxt(r.overFixedHours) + ' 時間' : 'なし']);
          const warns = [];
          if (r.fixedUnderLegal) warns.push('固定残業代を時間数で割った単価が、基礎賃金から計算した法定の残業単価を下回っています。固定残業代に含まれる手当の範囲や基礎賃金の算定を確認し、労働基準監督署・社会保険労務士・弁護士への相談をおすすめします。');
          if (r.fixedOver45) warns.push('固定残業時間が45時間を超えています。36協定の原則の上限（月45時間）を超える設定は、特別条項があっても常態化すれば問題になり得ます。');
          if (r.shortage > 0) warns.push('実際の残業代が固定残業代を上回る月は、会社は差額を支払う必要があります（最高裁 平成29年7月7日・平成30年7月19日判決の考え方、厚生労働省の指針）。');
          fx.innerHTML = `<h3>固定残業代（みなし残業代）のチェック結果</h3>${kvRows(rows)}${warns.map(w => `<p class="note">⚠ ${w}</p>`).join('')}`;
        } else fx.innerHTML = '';
      }
      if (tbl) {
        let rows = '';
        for (const m of [20, 25, 30, 35, 40, 50]) {
          const hl = Math.round(salary / 10000) === m ? ' class="hl"' : '';
          rows += `<tr${hl}><td class="num">${m}万円</td><td class="num">${yen(calcZangyo({ salary: m * 10000, dayHours: r.dayHours, holidays: r.holidays }).hourly)}</td>` + [10, 20, 30, 45, 60, 80].map(h => `<td class="num">${yen(calcZangyo({ salary: m * 10000, dayHours: r.dayHours, holidays: r.holidays, overtime: h }).total)}</td>`).join('') + '</tr>';
        }
        tbl.innerHTML = rows;
        const cap = $out('[data-quick-caption]', root);
        if (cap) cap.textContent = `条件: 1日${r.dayHours}時間・年間休日${r.holidays}日（月平均${hoursTxt(r.monthlyHours)}時間）・除外手当なし・深夜/休日なし（入力に連動して再計算しています）`;
      }
    });
  };

  TOOLS.juminzei = function (root) {
    const out = $('.result', root), tbl = $out('[data-quick]', root), hk = $out('[data-hikazei]', root);
    bindLive(root, () => {
      const income = num($('[name=income]', root)) * 10000;
      const shahoEl = $('[name=shaho]', root);
      const shahoRaw = shahoEl && String(shahoEl.value).trim() !== '' ? num(shahoEl) * 10000 : null;
      const opt = {
        income, age: num($('[name=age]', root)) || 30,
        spouse: !!($('[name=spouse]', root) && $('[name=spouse]', root).checked),
        ippan: num($('[name=ippan]', root)), tokutei: num($('[name=tokutei]', root)), under16: num($('[name=under16]', root)),
        kyuchi: ($('[name=kyuchi]', root) || {}).value || 1,
        tokurei: !!($('[name=tokurei]', root) && $('[name=tokurei]', root).checked),
        otherKojo: num($('[name=other]', root)) * 10000, shaho: shahoRaw
      };
      const r = calcJuminzei(opt);
      if (income <= 0) { out.classList.add('is-empty'); out.innerHTML = '<div class="big">年収を入力してください</div>'; return; }
      out.classList.remove('is-empty');
      const status = r.kintoFree ? '住民税は非課税（所得割・均等割とも0円）の目安です' : r.shotokuFree ? '所得割は非課税、均等割（＋森林環境税）のみ課税の目安です' : '';
      out.innerHTML = `<div class="sub">給与収入 ${man(income)}万円・${r.age}歳${r.spouse ? '・配偶者控除あり' : ''}${r.ippan ? `・一般扶養${r.ippan}人` : ''}${r.tokutei ? `・特定扶養${r.tokutei}人` : ''}${r.under16 ? `・16歳未満${r.under16}人` : ''}・${r.kyuchi}級地</div>
<div class="big">住民税 約 ${yen(r.total)} 円 <span class="sub">／年</span></div>
<div class="sub">${status || `給与天引き（特別徴収）は 6月 ${yen(r.june)} 円、7月〜翌5月 ${yen(r.monthly)} 円 ×11回（年収に対し ${(r.rate * 100).toFixed(1)}%）`}</div>
${kvRows([
        ['給与所得（収入−給与所得控除）', yen(r.kyuyo) + ' 円'],
        ['社会保険料控除' + (opt.shaho == null ? '（自動概算）' : ''), yen(r.shaho) + ' 円'],
        ['基礎控除（住民税）', yen(r.kiso) + ' 円'],
        ['配偶者控除・扶養控除（住民税）', yen(r.haiK + r.fuyo) + ' 円'],
        ['その他の所得控除', yen(r.other) + ' 円'],
        ['課税所得（1,000円未満切捨て）', yen(r.kazei) + ' 円'],
        ['調整控除', r.shotokuFree ? '—' : yen(r.chousei) + ' 円'],
        ['所得割 市区町村民税（6%）', yen(r.shi) + ' 円', r.shi ? 'neg' : ''],
        ['所得割 道府県民税（4%）', yen(r.ken) + ' 円', r.ken ? 'neg' : ''],
        ['均等割（市区町村3,000円＋道府県1,000円）', yen(r.kintowari) + ' 円', r.kintowari ? 'neg' : ''],
        ['森林環境税（国税）', yen(r.shinrin) + ' 円', r.shinrin ? 'neg' : ''],
        ['住民税 合計（年額）', yen(r.total) + ' 円'],
        ['普通徴収（4回払い）の場合', r.total ? `第1期 ${yen(r.ki1)} 円、第2〜4期 ${yen(r.ki)} 円` : '—']
      ])}
<p class="note">非課税ラインの判定: 合計所得金額 ${yen(r.kyuyo)} 円 ／ 均等割の非課税限度額 ${yen(r.kintoLine)} 円（${r.kyuchi}級地）／ 所得割の非課税限度額 ${yen(r.shotokuLine)} 円${r.tokureiHit ? ' ／ 障害者・未成年者・寡婦・ひとり親の135万円以下に該当' : ''}</p>`;
      if (hk) {
        const base = { spouse: opt.spouse, ippan: opt.ippan, tokutei: opt.tokutei, under16: opt.under16, kyuchi: opt.kyuchi, tokurei: opt.tokurei };
        hk.innerHTML = `<h3>この世帯構成で住民税がかからない年収の目安</h3>${kvRows([
          ['均等割も所得割もかからない給与収入', `${man(juminHikazeiIncome(base, 'kinto'))}万円以下`],
          ['所得割がかからない給与収入（社会保険料控除は考慮せず）', `${man(juminHikazeiIncome(base, 'shotoku'))}万円以下`]
        ])}`;
      }
      if (tbl) {
        let rows = '';
        for (const m of [100, 119, 150, 200, 300, 400, 500, 600, 700, 800, 1000, 1200, 1500]) {
          const q = (o) => calcJuminzei(Object.assign({ income: m * 10000, age: opt.age, kyuchi: opt.kyuchi }, o)).total;
          const a = q({});
          const hl = Math.round(income / 10000) === m ? ' class="hl"' : '';
          rows += `<tr${hl}><td class="num">${m.toLocaleString('ja-JP')}万円</td><td class="num">${yen(a)}</td><td class="num">${yen(floor100(a / 12))}</td><td class="num">${yen(q({ spouse: true }))}</td><td class="num">${yen(q({ spouse: true, ippan: 1 }))}</td><td class="num">${yen(q({ spouse: true, tokutei: 1 }))}</td></tr>`;
        }
        tbl.innerHTML = rows;
        const cap = $out('[data-quick-caption]', root);
        if (cap) cap.textContent = `条件: ${opt.age}歳・${opt.kyuchi}級地・社会保険料は自動概算・その他の控除なし（入力に連動して再計算しています）`;
      }
    });
  };

  TOOLS.kabe = function (root) {
    const out = $('.result', root), tbl = $out('[data-quick]', root);
    const chk = (n) => !!($(`[name=${n}]`, root) && $(`[name=${n}]`, root).checked);
    bindLive(root, () => {
      const income = num($('[name=income]', root)) * 10000;
      const relation = ($('[name=relation]', root) || {}).value || 'spouse';
      const opt = {
        income, relation, age: num($('[name=age]', root)) || (relation === 'tokutei' ? 20 : 40),
        earner: num($('[name=earner]', root)) * 10000, kyuchi: ($('[name=kyuchi]', root) || {}).value || 1,
        week20: chk('week20'), large: chk('large'), student: chk('student'), disability: chk('disability'),
        after: ($('[name=after]', root) || {}).value || 'kinmu', kokuho: num($('[name=kokuho]', root)) * 10000
      };
      const r = calcKabe(opt);
      if (income <= 0) { out.classList.add('is-empty'); out.innerHTML = '<div class="big">年収を入力してください</div>'; return; }
      out.classList.remove('is-empty');
      const who = { spouse: '配偶者', tokutei: '19〜22歳の子など', ippan: '扶養親族' }[relation];
      const mark = (over) => over ? '<span class="neg">超えている</span>' : '超えていない';
      const walls = [
        [`住民税の壁 ${man(r.juminLine)}万円（${r.kyuchi}級地・単身）`, mark(income > r.juminLine), '超えると本人に住民税（均等割など）'],
        ['所得税の壁 178万円', mark(income > KABE.shotokuzeiLine), '超えると本人に所得税（社会保険料を払っていればもう少し上）'],
        [`扶養控除の壁 136万円`, mark(r.kyuyo > KABE.fuyoShotoku), relation === 'ippan' ? '超えると扶養者の扶養控除38万円がゼロに' : relation === 'spouse' ? '超えると配偶者特別控除に切替（169万円までは同額）' : '超えると特定親族特別控除に切替（159万円までは同額）'],
        [`社会保険の扶養 ${man(r.fuyoLimit)}万円`, r.shahoJoin ? '勤務先で加入' : mark(!r.fuyoIn), '以上になると扶養を外れ、本人が保険料を負担'],
        ['勤務先の社会保険（週20時間以上・51人以上）', r.shahoJoin ? '<span class="neg">加入対象</span>' : '対象外', '106万円の賃金要件は2026年10月に撤廃。年収に関係なく加入']
      ];
      if (relation === 'spouse') walls.push(['配偶者特別控除が減り始める 169万円／なくなる 207万円', income > 2070000 ? '<span class="neg">207万円超</span>' : mark(r.kyuyo > 950000), '扶養者の所得税が段階的に増える']);
      if (relation === 'tokutei') walls.push(['特定親族特別控除が減り始める 159万円／なくなる 197万円', income > 1970000 ? '<span class="neg">197万円超</span>' : mark(r.kyuyo > 850000), '扶養者の所得税が段階的に増える']);
      const be = kabeBreakEven(opt);
      out.innerHTML = `<div class="sub">${who}の年収 ${man(income)}万円・${r.age}歳／扶養者の年収 ${man(r.earner)}万円</div>
<div class="big">本人の手取り 約 ${yen(r.tedori)} 円 <span class="sub">／年</span></div>
<div class="sub">扶養者の所得税の増加 ${yen(r.earnerTaxUp)} 円を差し引いた世帯の手取り増分: 約 ${yen(r.household)} 円</div>
<h3>壁の判定</h3>${kvRows(walls.map(([k, v, d]) => [`${k}<br><span class="note">${d}</span>`, v]))}
<h3>内訳</h3>${kvRows([
        ['本人の社会保険', r.shahoLabel],
        ['本人の社会保険料（年）', yen(r.shaho) + ' 円', r.shaho ? 'neg' : ''],
        ['本人の所得税（年）', yen(r.shotokuzei) + ' 円', r.shotokuzei ? 'neg' : ''],
        ['本人の住民税（翌年度・年）', yen(r.juminzei) + ' 円', r.juminzei ? 'neg' : ''],
        ['扶養者が受けられる控除（所得税）', `${r.kojo.name} ${yen(r.kojo.amount)} 円`],
        ['扶養者の所得税の増加（税率' + Math.round(r.earnerRate * 100) + '%で概算）', yen(r.earnerTaxUp) + ' 円', r.earnerTaxUp ? 'neg' : '']
      ])}
<p class="note">${r.shahoJoin ? '勤務先の社会保険に加入しているため、130万円の扶養の壁による手取りの落ち込みはありません（保険料は年収に比例）。' : be ? `社会保険の扶養（${man(r.fuyoLimit)}万円）を外れた直後に手取りが減り、世帯の手取りが元に戻るのは年収 約${man(be)}万円 からです（この入力条件での目安）。` : ''}${opt.after === 'kokuho' && !r.fuyoIn && !r.shahoJoin && !opt.kokuho ? ' 国民健康保険料が未入力のため、実際の負担はこれより大きくなります。' : ''}</p>`;
      if (tbl) {
        let rows = '';
        const marks = [100, 110, 119, 125, 129, 130, 136, 140, 150, 160, 169, 178, 190, 200, 207, 220];
        for (const m of marks) {
          const q = calcKabe(Object.assign({}, opt, { income: m * 10000 }));
          const hl = Math.round(income / 10000) === m ? ' class="hl"' : '';
          rows += `<tr${hl}><td class="num">${m}万円</td><td class="num">${yen(q.shaho)}</td><td class="num">${yen(q.shotokuzei + q.juminzei)}</td><td class="num">${yen(q.tedori)}</td><td class="num">${yen(q.kojo.amount)}</td><td class="num">${yen(q.earnerTaxUp)}</td><td class="num">${yen(q.household)}</td></tr>`;
        }
        tbl.innerHTML = rows;
        const cap = $out('[data-quick-caption]', root);
        if (cap) cap.textContent = `条件: ${who}・${r.age}歳・扶養者の年収${man(r.earner)}万円・${r.shahoJoin ? '勤務先の社会保険に加入' : '扶養を外れたら' + (opt.after === 'kokuho' ? '国民年金＋国保' : '勤務先の社会保険に加入')}（入力に連動して再計算しています）`;
      }
    });
  };

  TOOLS.ideco = function (root) {
    const out = $('.result', root), tbl = $out('[data-quick]', root), chart = $out('[data-chart]', root);
    bindLive(root, () => {
      const kind = ($('[name=kind]', root) || {}).value || 'nashi';
      const shahoEl = $('[name=shaho]', root);
      const opt = {
        kind, corp: num($('[name=corp]', root)), income: num($('[name=income]', root)) * 10000,
        age: num($('[name=age]', root)) || 30, dependents: num($('[name=dependents]', root)),
        monthly: num($('[name=monthly]', root)), rate: num($('[name=rate]', root)), years: num($('[name=years]', root)) || 1,
        shaho: shahoEl && shahoEl.value !== '' ? num(shahoEl) * 10000 : null
      };
      const r = calcIdeco(opt);
      root.querySelectorAll('[data-show]').forEach(el => { el.hidden = !el.dataset.show.split(' ').includes(r.kind); });
      if (!r.limit || r.monthly <= 0) { if (chart) chart.innerHTML = ''; }
      if (!r.limit) { out.classList.remove('is-empty'); out.innerHTML = `<div class="big">掛金の上限が5,000円未満のため、iDeCoに拠出できません</div><p class="note">企業年金等の掛金相当額が月${yen(r.corp)}円のため、6.2万円から差し引いた上限が下限の5,000円を下回ります。</p>`; return; }
      if (r.monthly <= 0) { out.classList.add('is-empty'); out.innerHTML = `<div class="big">掛金を入力してください（上限 月${yen(r.limit)}円）</div>`; return; }
      out.classList.remove('is-empty');
      out.innerHTML = `<div class="sub">${r.label}・${kind === 'jiei' ? '所得' : '年収'} ${man(r.income)}万円・掛金 月${yen(r.monthly)}円・${r.years}年（${r.age}〜${r.endAge}歳）</div>
<div class="big">年間の節税額 約 ${yen(r.saveYear)} 円</div>
<div class="sub">所得税 ${yen(r.saveS)} 円＋住民税 ${yen(r.saveJ)} 円（掛金の約${Math.round(r.saveRate * 100)}%が戻る計算）</div>
${r.capped ? `<p class="note"><span class="neg">入力した掛金が上限を超えるため、月${yen(r.limit)}円で計算しています。</span></p>` : ''}
<h3>掛金の上限</h3>${kvRows([
        ['2026年12月分（2027年1月引落し）から', `月 ${yen(r.limit)} 円（年 ${yen(r.limit * 12)} 円）`],
        ['2026年11月分まで', r.oldLimit ? `月 ${yen(r.oldLimit)} 円` : '拠出不可'],
        ...(r.corp ? [['差し引いた企業年金等の掛金相当額', `月 ${yen(r.corp)} 円`]] : [])
      ])}
<h3>拠出時: 所得税・住民税の軽減</h3>${kvRows([
        ['年間の掛金（全額が小規模企業共済等掛金控除）', yen(r.annual) + ' 円'],
        [`所得税（税率${r.before.rate * 100}%・復興税込み）`, `${yen(r.before.shotokuzei)} → ${yen(r.after.shotokuzei)} 円`],
        ['住民税所得割（10%）', `${yen(r.before.jumin)} → ${yen(r.after.jumin)} 円`],
        ['年間の節税額', yen(r.saveYear) + ' 円'],
        [`${r.years}年間の節税額の合計（同じ収入が続く場合）`, yen(r.saveTotal) + ' 円']
      ])}
<h3>運用: 年${opt.rate}%で${r.years}年積み立てた場合</h3>${kvRows([
        ['掛金の合計', yen(r.paid) + ' 円'],
        ['運用益', yen(r.gain) + ' 円'],
        ['受取時の資産', yen(r.final) + ' 円'],
        ['運用益が非課税になる効果（課税口座なら20.315%）', yen(r.gainTax) + ' 円']
      ])}
<h3>受取時と手数料</h3>${kvRows([
        [`一時金で受け取った場合の税（退職所得控除 ${yen(r.kojo)} 円）`, yen(r.receiveTax) + ' 円', r.receiveTax ? 'neg' : ''],
        [`手数料（加入時2,829円＋月186円×${r.years * 12}か月）`, yen(r.fees) + ' 円', 'neg'],
        ['差し引きの効果の目安', yen(r.net) + ' 円']
      ])}
<p class="note">受取時の税は、iDeCoだけを一時金で受け取り、退職所得控除を加入年数${r.years}年で計算した場合の目安です。会社の退職金を同じ年や近い年に受け取ると控除が重複調整され、税が増えることがあります。60歳まで原則引き出せません。</p>`;
      if (chart) chart.innerHTML = lineChart([r.series.map(s => s.bal), r.series.map(s => s.paid)], { label: '資産推移', xLabel: i => (r.age + i) + '歳' }) + '<div class="legend"><span><i class="c1"></i>資産額</span><span><i class="c2"></i>掛金の合計</span></div>';
      if (tbl) {
        let rows = '';
        const ms = [10000, 23000, r.limit > 23000 ? r.limit : 0].filter(Boolean);
        for (const m of [300, 400, 500, 600, 700, 800, 1000]) {
          const cell = (mon) => { const q = calcIdeco(Object.assign({}, opt, { income: m * 10000, monthly: mon })); return `<td class="num">${yen(q.saveYear)}</td>`; };
          const hl = Math.round(r.income / 10000) === m ? ' class="hl"' : '';
          rows += `<tr${hl}><td class="num">${m.toLocaleString('ja-JP')}万円</td>` + ms.map(cell).join('') + (ms.length < 3 ? '<td class="num">—</td>' : '') + '</tr>';
        }
        tbl.innerHTML = rows;
        const head = $out('[data-quick-head]', root);
        if (head) head.innerHTML = `<th>${kind === 'jiei' ? '所得' : '年収'}</th>` + ms.map(mm => `<th class="num">月${yen(mm)}円</th>`).join('') + (ms.length < 3 ? '<th class="num">—</th>' : '');
        const cap = $out('[data-quick-caption]', root);
        if (cap) cap.textContent = `条件: ${r.label}・${r.age}歳・扶養${r.dep}人（入力に連動して再計算しています）。金額は年間の節税額（円）`;
      }
    });
  };

  // ---------- 起動 ----------
  function boot() {
    document.querySelectorAll('[data-tool]').forEach(root => {
      const fn = TOOLS[root.dataset.tool];
      if (fn) { try { fn(root); root.classList.add('js-ready'); } catch (e) { console.error(e); } }
    });
    const y = document.querySelector('[data-year]'); if (y) y.textContent = new Date().getFullYear();
  }
  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
  }

  const api = { RATES, kyuyoKojo, kyuyoShotoku, kisoKojoShotoku, kisoKojoJumin, incomeTax, incomeTaxRate, standardMonthly, calcTedori, calcLoan, calcFurusato, calcTsumitate, calcTaishokukin, SHITSUGYO, kihonTeate, kyufuNissu, calcShitsugyo, ZANGYO_RATES, calcZangyo, JUMIN, calcJuminzei, juminHikazeiIncome, KABE, kabeKojo, calcKabe, kabeBreakEven, IDECO, idecoLimit, idecoTax, calcIdeco, lineChart };
  global.CalcHub = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
