const express = require('express');
const mongoose = require('mongoose');
const mysql = require('mysql');  // MySQL 모듈 추가
const User = require('./models/User');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const cors = require('cors');
const dotenv = require('dotenv');
const OpenAI = require("openai");
const promClient = require('prom-client');

// 환경 변수 로드
dotenv.config();

// 필수 환경 변수 확인
if (!process.env.MONGO_URI || !process.env.JWT_SECRET || !process.env.OPENAI_API_KEY || !process.env.DB_HOST) {
  console.error("필수 환경 변수가 설정되지 않았습니다.");
  process.exit(1); // 환경 변수가 없으면 서버 종료
}

const port = process.env.PORT || 8080;

// MongoDB 연결 설정
mongoose.connect(process.env.MONGO_URI, {
  useNewUrlParser: true,
  useUnifiedTopology: true,
})
.catch(error => {
  console.error('MongoDB 연결 오류:', error);
  process.exit(1); // MongoDB 연결 실패 시 서버 종료
});

const db = mongoose.connection;
db.on('error', console.error.bind(console, 'MongoDB connection error:'));
db.once('open', () => {
  console.log('Connected to MongoDB');
});

// MySQL (MariaDB) 연결 설정
const connection = mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT
});

// MySQL 연결 시도
connection.connect((err) => {
  if (err) {
    console.error('MySQL 연결 오류:', err);
    return;
  }
  console.log('MySQL에 연결되었습니다.');
});

// Prometheus 기본 메트릭 수집
const collectDefaultMetrics = promClient.collectDefaultMetrics;
collectDefaultMetrics();

// Prometheus 레지스트리
const register = promClient.register;

// 요청 처리 시간 측정을 위한 히스토그램 설정
const httpRequestDurationMicroseconds = new promClient.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Duration of HTTP requests in seconds',
  labelNames: ['method', 'route', 'code'],
  buckets: [0.1, 0.5, 1, 2, 5]
});

// 미들웨어 설정
const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// 요청 처리 시간 측정 미들웨어
app.use((req, res, next) => {
  const end = httpRequestDurationMicroseconds.startTimer();
  res.on('finish', () => {
    end({ method: req.method, route: req.route ? req.route.path : 'unknown', code: res.statusCode });
  });
  next();
});

// /metrics 엔드포인트로 메트릭 제공
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', register.contentType);
  res.end(await register.metrics());
});

// OpenAI 설정
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// ChatGPT API와 상호작용하는 함수
async function getChatGPTResponse(messages, systemRole) {
  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4",
      messages: [
        { role: "system", content: systemRole || "You are a helpful assistant." },
        ...messages
      ],
      temperature: 1,
      max_tokens: 256,
    });
    return response.choices[0].message.content;
  } catch (error) {
    console.error("ChatGPT API와 상호작용 중 오류 발생:", error);
    throw new Error('ChatGPT API 오류 발생');
  }
}

// JWT 인증 미들웨어
const authenticateToken = (req, res, next) => {
  const token = req.header('Authorization')?.replace('Bearer ', '');
  if (!token) {
    return res.status(401).json({ message: '토큰이 없습니다.' });
  }

  try {
    const verified = jwt.verify(token, process.env.JWT_SECRET);
    req.user = verified;
    next();
  } catch (error) {
    return res.status(403).json({ message: '유효하지 않은 토큰입니다.' });
  }
};

// MongoDB Conversation 스키마 정의
const conversationSchema = new mongoose.Schema({
  userId: String,
  role: String,
  content: String,
  timestamp: { type: Date, default: Date.now }
});

const Conversation = mongoose.model('Conversation', conversationSchema); // Conversation 모델 정의

// 사용자 등록 라우트
app.post('/api/register', async (req, res) => {
  const { name, email, password } = req.body;

  if (!name || !email || !password) {
    return res.status(400).json({ message: '모든 필드를 입력해주세요.' });
  }

  try {
    // 1. MongoDB에서 사용자 확인
    const existingUserMongo = await User.findOne({ email });
    if (existingUserMongo) {
      return res.status(400).json({ message: '이미 존재하는 사용자입니다.' });
    }

    // 2. MySQL에서 사용자 확인
    const query = `SELECT * FROM users WHERE email = ?`;
    connection.query(query, [email], async (err, results) => {
      if (err) {
        console.error('MySQL 쿼리 오류:', err);
        return res.status(500).json({ message: 'MySQL에서 사용자 확인 중 오류가 발생했습니다.' });
      }

      if (results.length > 0) {
        return res.status(400).json({ message: '이미 존재하는 사용자입니다.' });
      }

      // 3. 비밀번호 해싱
      const hashedPassword = await bcrypt.hash(password, 10);

      // 4. MongoDB에 사용자 저장
      const newUser = new User({
        name,
        email,
        password: hashedPassword,
      });
      await newUser.save();

      // 5. MySQL에 사용자 저장
      const insertQuery = `INSERT INTO users (name, email, password) VALUES (?, ?, ?)`;
      connection.query(insertQuery, [name, email, hashedPassword], (err, result) => {
        if (err) {
          console.error('MySQL 사용자 저장 오류:', err);
          return res.status(500).json({ message: 'MySQL에 사용자 저장 중 오류가 발생했습니다.' });
        }

        // 6. JWT 발급
        const token = jwt.sign({ id: newUser._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

        res.status(201).json({ token, message: '사용자가 성공적으로 등록되었습니다.' });
      });
    });
  } catch (error) {
    console.error('사용자 등록 중 오류:', error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
});

// 사용자 목록 조회 라우트 (GET /api/users)
app.get('/api/users', authenticateToken, async (req, res) => {
  try {
    // MongoDB에서 사용자 목록 가져오기
    const users = await User.find({}, { password: 0 });
    res.status(200).json(users);

    // MariaDB에서 사용자 목록 가져오기
    connection.query('SELECT * FROM users', (err, results) => {
      if (err) {
        console.error('MySQL 쿼리 오류:', err);
        return;
      }
      console.log('MySQL 사용자 목록:', results);
    });
  } catch (error) {
    console.error("사용자 목록 조회 중 오류:", error);
    res.status(500).json({ message: '사용자 조회 중 오류 발생' });
  }
});

// 로그인 라우트
app.post('/api/login', async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ message: '이메일과 비밀번호를 입력해주세요.' });
  }

  try {
    // 1. MongoDB에서 사용자 찾기
    const user = await User.findOne({ email });
    if (!user) {
      return res.status(400).json({ message: '잘못된 이메일 또는 비밀번호입니다.' });
    }

    // 2. 입력된 비밀번호와 해싱된 비밀번호 비교
    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) {
      return res.status(400).json({ message: '잘못된 이메일 또는 비밀번호입니다.' });
    }

    // 3. JWT 토큰 발급
    const token = jwt.sign({ id: user._id }, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.json({ token, message: '로그인 성공!' });
  } catch (error) {
    console.error("로그인 중 오류:", error);
    res.status(500).json({ message: '서버 오류 발생' });
  }
});

// 대화 기록과 ChatGPT와의 상호작용
app.post('/api/chatbot', authenticateToken, async (req, res) => {
  const { message, systemRole } = req.body;

  try {
    const userId = req.user.id;
    const user = await User.findById(userId);

    if (systemRole) {
      user.systemRole = systemRole;
      await user.save();
    }

    // Conversation 모델 사용
    const conversation = await Conversation.find({ userId });

    const botResponse = await getChatGPTResponse([...conversation.map(c => ({
      role: c.role, content: c.content
    })), { role: 'user', content: message }], user.systemRole);

    await new Conversation({ userId, role: 'user', content: message }).save();
    await new Conversation({ userId, role: 'assistant', content: botResponse }).save();

    res.json({ response: botResponse });
  } catch (error) {
    console.error("ChatGPT API와 상호작용 중 오류:", error);
    res.status(500).json({ message: 'ChatGPT와의 상호작용 중 오류 발생' });
  }
});

// 서버 실행
app.listen(port, '0.0.0.0', () => {
  console.log(`서버가 실행 중입니다. http://localhost:${port}`);
});

