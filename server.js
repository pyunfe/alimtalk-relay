// 알리고 알림톡 발송용 고정 IP 중계 서버.
// Supabase Edge Function은 매 호출마다 아웃바운드 IP가 바뀌어서 알리고의
// "발송 서버 IP" 화이트리스트와 근본적으로 호환이 안 됨 -> 고정 IP를 제공하는
// 플랫폼(Render 등)에 이 서버를 올려서, 여기서만 알리고 API를 호출하도록 함.
//
// 배포 후 이 서버의 아웃바운드 IP를 확인해서 알리고 "발송 서버 IP"에 등록해야 함.
// (플랫폼이 알려주는 고정 IP를 그대로 등록. 확인 방법은 GET /debug-ip 참고)

const express = require('express');
const app = express();
app.use(express.json());

const PORT = process.env.PORT || 8080;
const RELAY_API_KEY = process.env.RELAY_API_KEY || '';

const ALIGO_APIKEY = process.env.ALIGO_APIKEY || '';
const ALIGO_USERID = process.env.ALIGO_USERID || '';
const ALIGO_SENDERKEY = process.env.ALIGO_SENDERKEY || '';
const ALIGO_SENDER_PHONE = process.env.ALIGO_SENDER_PHONE || '';
const ALIGO_TPL_CODE_CONSULT = process.env.ALIGO_TPL_CODE_CONSULT || '';

function requireApiKey(req, res, next) {
    if (!RELAY_API_KEY) return next(); // 키 미설정 시 검증 생략(테스트 편의)
    if (req.get('x-api-key') !== RELAY_API_KEY) {
        return res.status(401).json({ ok: false, error: 'invalid api key' });
    }
    next();
}

// 승인 심사에 넣은 실제 템플릿 원문 (템플릿 코드 UK_6931, "상담 예약 완료").
// 변수는 학생명/학교학년/담당쌤/상담일자/상담시간 다섯 개뿐이고, 나머지는 고정 문구라서
// 여기 텍스트가 카카오에 승인된 문구와 토씨 하나도 다르면 안 됨.
// 알리고에 등록된 원문이 CRLF(\r\n) 줄바꿈이라 여기도 반드시 \r\n으로 맞춰야 함.
function buildConsultDoneMessage({ studentName, schoolGrade, teacherName, reservationDate, reservationTime }) {
    const lines = [
        '[국성국어전문학원]',
        '안녕하세요. 국성국어 전문학원입니다.',
        '상담 예약이 확정되었습니다.',
        '',
        `▶ 학생명 : ${studentName}`,
        `▶ 학교/학년 : ${schoolGrade}`,
        `▶ 담당 선생님 : ${teacherName}`,
        `▶ 상담 일시 : ${reservationDate} ${reservationTime}`,
        '',
        '[오시는 길]',
        '인천 서해구 청라에메랄드로102번길 8,',
        '8층 국성국어 본관',
        '',
        '※ 일정 변동 시',
        '학원((콜)032-568-9565)으로',
        '전화 부탁드립니다. 감사합니다.',
        '채널 추가하고 이 채널의 광고와 마케팅 메시지를 카카오톡으로 받기'
    ];
    return lines.join('\r\n');
}

app.get('/', (req, res) => {
    res.json({ ok: true, service: 'alimtalk-relay' });
});

// 환경변수가 실제로 어떻게 로드됐는지 확인용 (민감정보는 일부만 마스킹해서 노출. 확인 후 지워도 됨)
app.get('/debug-env', requireApiKey, (req, res) => {
    const mask = (s) => s ? `${s.slice(0, 3)}...${s.slice(-3)} (len:${s.length})` : '(empty)';
    res.json({
        ALIGO_APIKEY: mask(ALIGO_APIKEY),
        ALIGO_USERID: ALIGO_USERID,
        ALIGO_SENDERKEY: mask(ALIGO_SENDERKEY),
        ALIGO_SENDER_PHONE: ALIGO_SENDER_PHONE,
        ALIGO_TPL_CODE_CONSULT: JSON.stringify(ALIGO_TPL_CODE_CONSULT)
    });
});

// 이 서버가 실제로 어떤 IP로 나가는지 확인용 (알리고에 등록할 IP 확인 후 지워도 됨)
app.get('/debug-ip', async (req, res) => {
    const r = await fetch('https://api.ipify.org?format=json');
    res.json(await r.json());
});

// 알리고 서버에 등록된 템플릿 원문 조회용 (디버그. 확인 후 지워도 됨)
app.get('/debug-template', requireApiKey, async (req, res) => {
    const params = new URLSearchParams({
        apikey: ALIGO_APIKEY,
        userid: ALIGO_USERID,
        senderkey: ALIGO_SENDERKEY,
        tpl_code: req.query.tpl_code || ''
    });
    const r = await fetch('https://kakaoapi.aligo.in/akv10/template/list/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });
    res.json(await r.json().catch(() => ({})));
});

// 특정 발송건의 실제 처리 결과 조회용 (디버그. 확인 후 지워도 됨)
app.get('/debug-history', requireApiKey, async (req, res) => {
    const params = new URLSearchParams({
        apikey: ALIGO_APIKEY,
        userid: ALIGO_USERID,
        mid: req.query.mid || ''
    });
    const r = await fetch('https://kakaoapi.aligo.in/akv10/history/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
    });
    res.json(await r.json().catch(() => ({})));
});

app.post('/notify-consult', requireApiKey, async (req, res) => {
    const { student_name, phone, school, grade, teacher_name, reservation_date, reservation_time } = req.body || {};

    if (!phone) {
        return res.status(400).json({ ok: false, error: '연락처 없음' });
    }

    const message = buildConsultDoneMessage({
        studentName: student_name || '',
        schoolGrade: [school, grade].filter(Boolean).join(' '),
        teacherName: teacher_name || '',
        reservationDate: reservation_date || '',
        reservationTime: reservation_time || ''
    });

    const params = new URLSearchParams({
        apikey: ALIGO_APIKEY,
        userid: ALIGO_USERID,
        senderkey: ALIGO_SENDERKEY,
        tpl_code: ALIGO_TPL_CODE_CONSULT,
        sender: ALIGO_SENDER_PHONE,
        receiver_1: phone,
        subject_1: '상담 예약 완료 안내',
        message_1: message,
        recvname_1: student_name || '',
        // 승인된 템플릿에 "채널 추가" 버튼(linkType: AC)이 붙어있어서, 이 버튼 정보를
        // 그대로 안 보내면 템플릿과 불일치로 처리되어 발송이 실패함.
        button_1: JSON.stringify({ button: [{ name: '채널 추가', linkType: 'AC' }] })
    });

    try {
        const aligoRes = await fetch('https://kakaoapi.aligo.in/akv10/alimtalk/send/', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: params.toString()
        });
        const json = await aligoRes.json().catch(() => ({}));
        res.status(aligoRes.ok ? 200 : 502).json({ ok: aligoRes.ok, raw: json });
    } catch (err) {
        res.status(500).json({ ok: false, error: err.message });
    }
});

app.listen(PORT, () => {
    console.log(`알림톡 중계 서버 실행 중 (포트 ${PORT})`);
});
