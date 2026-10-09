// Zentrale Konfiguration – alle Werte kommen aus Umgebungsvariablen (.env).
const env = process.env;

const int = (v, d) => (v === undefined || v === '' ? d : Number.parseInt(v, 10));

export const config = {
  env: env.NODE_ENV || 'development',
  port: int(env.PORT, 3000),
  // Öffentliche Adresse dieser App, z. B. https://empfang-ki.de
  publicUrl: (env.PUBLIC_URL || 'http://localhost:3000').replace(/\/$/, ''),

  databaseUrl: env.DATABASE_URL || 'postgres://empfang:empfang@localhost:5432/empfang',

  llm: {
    // "anthropic" für echte Antworten, "mock" für lokale Entwicklung ohne API-Key
    provider: env.LLM_PROVIDER || (env.ANTHROPIC_API_KEY ? 'anthropic' : 'mock'),
    apiKey: env.ANTHROPIC_API_KEY || '',
    model: env.LLM_MODEL || 'claude-haiku-4-5',
    maxTokens: int(env.LLM_MAX_TOKENS, 700),
  },

  // Kleine Wissensbasen (bis zu diesem Token-Budget) werden komplett in den
  // Prompt gelegt (mit Prompt-Caching). Größere werden per Volltextsuche gefiltert.
  knowledge: {
    fullContextTokenBudget: int(env.KNOWLEDGE_FULL_CONTEXT_TOKENS, 24000),
    topK: int(env.KNOWLEDGE_TOP_K, 8),
  },

  chat: {
    maxMessageChars: int(env.CHAT_MAX_MESSAGE_CHARS, 1200),
    historyMessages: int(env.CHAT_HISTORY_MESSAGES, 16),
    maxMessagesPerConversation: int(env.CHAT_MAX_MESSAGES_PER_CONVERSATION, 60),
    perMinuteLimit: int(env.CHAT_RATE_LIMIT_PER_MINUTE, 15),
  },

  // Datensparsamkeit: Gespräche werden nach X Tagen automatisch gelöscht
  retentionDays: int(env.RETENTION_DAYS, 30),

  adminToken: env.ADMIN_TOKEN || '',
  // Bekommt Erinnerungen (z. B. Gründerpreis läuft ab). Standard: Absenderadresse aus MAIL_FROM
  adminEmail: env.ADMIN_EMAIL || (env.MAIL_FROM || '').match(/[\w.+-]+@[\w.-]+/)?.[0] || '',

  // Testphase für neue Kunden (Tage); danach wird der Assistent ohne Zahlung ausgeschaltet
  trialDays: int(env.TRIAL_DAYS, 14),

  stripe: {
    secretKey: env.STRIPE_SECRET_KEY || '',
    webhookSecret: env.STRIPE_WEBHOOK_SECRET || '',
    // Preis-IDs der Monatsabos aus dem Stripe-Dashboard (price_...)
    prices: {
      starter: env.STRIPE_PRICE_STARTER || '',
      business: env.STRIPE_PRICE_BUSINESS || '',
      pro: env.STRIPE_PRICE_PRO || '',
    },
  },

  mail: {
    host: env.SMTP_HOST || '',
    port: int(env.SMTP_PORT, 587),
    user: env.SMTP_USER || '',
    pass: env.SMTP_PASS || '',
    from: env.MAIL_FROM || 'Empfang KI <no-reply@localhost>',
    // Wohin Antworten auf System-Mails gehen (z. B. wenn MAIL_FROM kein eigenes Postfach hat)
    replyTo: env.MAIL_REPLY_TO || '',
  },
};

export const isProd = config.env === 'production';
