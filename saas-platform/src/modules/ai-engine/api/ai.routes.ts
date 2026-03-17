'use client';

import { useState, useEffect } from 'react';
import { Sparkles, RefreshCw, AlertTriangle, TrendingUp, Zap, MessageSquare, Send, ChevronRight } from 'lucide-react';
import { api } from '@/lib/api';

interface AiInsight {
  briefing:  string;
  actions:   { priority: 'high' | 'medium' | 'low'; title: string; description: string }[];
  alerts:    string[];
  fromCache: boolean;
}

interface Credits {
  used:      number;
  limit:     number | null;
  remaining: number | null;
  unlimited: boolean;
}

const PRIORITY_CONFIG = {
  high:   { color: 'bg-rose-500',  label: 'Hoog',   text: 'text-rose-400'  },
  medium: { color: 'bg-amber-500', label: 'Middel', text: 'text-amber-400' },
  low:    { color: 'bg-slate-500', label: 'Laag',   text: 'text-slate-400' },
};

export default function AiInsightsPage() {
  const [insight,     setInsight]     = useState<AiInsight | null>(null);
  const [credits,     setCredits]     = useState<Credits | null>(null);
  const [loading,     setLoading]     = useState(true);
  const [refreshing,  setRefreshing]  = useState(false);
  const [chatMsg,     setChatMsg]     = useState('');
  const [chatHistory, setChatHistory] = useState<{ role: 'user' | 'assistant'; content: string }[]>([]);
  const [chatLoading, setChatLoading] = useState(false);
  const [error,       setError]       = useState('');

  const loadInsights = async (force = false) => {
    if (force) setRefreshing(true);
    else setLoading(true);
    setError('');
    try {
      const [ins, cr] = await Promise.all([
        api.get('/ai/insights' + (force ? '?force=true' : '')),
        api.get('/ai/credits'),
      ]);
      setInsight(ins.data);
      setCredits(cr.data);
    } catch (e: any) {
      setError(e.response?.data?.message || 'Kon inzichten niet laden.');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => { loadInsights(); }, []);

  const handleChat = async () => {
    if (!chatMsg.trim() || chatLoading) return;
    const userMsg = chatMsg.trim();
    setChatMsg('');
    setChatHistory(h => [...h, { role: 'user', content: userMsg }]);
    setChatLoading(true);
    try {
      const res = await api.post('/ai/chat', { message: userMsg });
      setChatHistory(h => [...h, { role: 'assistant', content: res.data.response }]);
    } catch {
      setChatHistory(h => [...h, { role: 'assistant', content: 'Er ging iets mis. Probeer opnieuw.' }]);
    } finally {
      setChatLoading(false);
    }
  };

  const creditsDisplay = credits
    ? (credits.unlimited ? '∞' : (credits.remaining ?? 0).toLocaleString('nl-NL'))
    : '—';

  return (
    <div className="p-6 max-w-4xl mx-auto">
      <div className="flex items-center justify-between mb-8">
        <div>
          <h1 className="font-display text-2xl font-800 text-white mb-1">AI Insights</h1>
          <p className="text-slate-400 text-sm">Dagelijkse briefing op basis van jouw verkoopdata</p>
        </div>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 bg-slate-800/60 border border-slate-700/50 rounded-xl px-3 py-2">
            <Zap className="w-3.5 h-3.5 text-violet-400" />
            <span className="text-xs font-medium text-slate-300">{creditsDisplay} credits</span>
          </div>
          <button
            onClick={() => loadInsights(true)}
            disabled={refreshing || loading}
            className="flex items-center gap-2 bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white text-sm font-semibold px-4 py-2 rounded-xl transition-all"
          >
            <RefreshCw className={'w-3.5 h-3.5 ' + (refreshing ? 'animate-spin' : '')} />
            {refreshing ? 'Vernieuwen...' : 'Vernieuwen'}
          </button>
        </div>
      </div>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/20 rounded-2xl p-4 mb-6 flex items-center gap-3">
          <AlertTriangle className="w-4 h-4 text-rose-400 flex-shrink-0" />
          <p className="text-sm text-rose-300">{error}</p>
          <button onClick={() => loadInsights(true)} className="ml-auto text-xs text-rose-400 hover:text-rose-300 font-medium">Opnieuw</button>
        </div>
      )}

      {loading && !insight && (
        <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-8 text-center">
          <div className="w-8 h-8 border-2 border-brand-500 border-t-transparent rounded-full animate-spin mx-auto mb-4" />
          <p className="text-slate-400 text-sm">AI analyseert jouw verkoopdata...</p>
        </div>
      )}

      {insight && (
        <>
          {insight.fromCache && (
            <div className="flex items-center gap-2 text-xs text-slate-500 mb-4">
              <div className="w-1.5 h-1.5 rounded-full bg-slate-500" />
              Gecachede briefing — klik Vernieuwen voor nieuwe inzichten
            </div>
          )}

          <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-6 mb-4">
            <div className="flex items-center gap-2 mb-4">
              <Sparkles className="w-4 h-4 text-brand-400" />
              <h2 className="text-sm font-semibold text-slate-300">Briefing van vandaag</h2>
            </div>
            <p className="text-white text-sm leading-relaxed">{insight.briefing}</p>
          </div>

          {insight.alerts.length > 0 && (
            <div className="space-y-2 mb-4">
              {insight.alerts.map((alert, i) => (
                <div key={i} className="flex items-start gap-3 bg-amber-500/10 border border-amber-500/20 rounded-xl p-3">
                  <AlertTriangle className="w-4 h-4 text-amber-400 flex-shrink-0 mt-0.5" />
                  <p className="text-xs text-amber-300">{alert}</p>
                </div>
              ))}
            </div>
          )}

          {insight.actions.length > 0 && (
            <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-6 mb-4">
              <div className="flex items-center gap-2 mb-4">
                <TrendingUp className="w-4 h-4 text-emerald-400" />
                <h2 className="text-sm font-semibold text-slate-300">Aanbevolen acties</h2>
              </div>
              <div className="space-y-3">
                {insight.actions.map((action, i) => {
                  const cfg = PRIORITY_CONFIG[action.priority] || PRIORITY_CONFIG.low;
                  return (
                    <div key={i} className="flex items-start gap-3 p-3 bg-slate-900/40 rounded-xl">
                      <div className={'w-2 h-2 rounded-full mt-1.5 flex-shrink-0 ' + cfg.color} />
                      <div className="flex-1">
                        <div className="flex items-center gap-2 mb-1">
                          <span className="text-sm font-medium text-white">{action.title}</span>
                          <span className={'text-xs font-medium ' + cfg.text}>{cfg.label}</span>
                        </div>
                        <p className="text-xs text-slate-400 leading-relaxed">{action.description}</p>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-600 flex-shrink-0 mt-0.5" />
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="bg-slate-800/50 border border-slate-700/50 rounded-2xl p-6">
            <div className="flex items-center gap-2 mb-4">
              <MessageSquare className="w-4 h-4 text-brand-400" />
              <h2 className="text-sm font-semibold text-slate-300">Stel een vraag</h2>
            </div>
            {chatHistory.length > 0 && (
              <div className="space-y-3 mb-4 max-h-64 overflow-y-auto">
                {chatHistory.map((msg, i) => (
                  <div key={i} className={'flex ' + (msg.role === 'user' ? 'justify-end' : 'justify-start')}>
                    <div className={'max-w-[80%] px-3 py-2 rounded-xl text-sm ' + (msg.role === 'user' ? 'bg-brand-600 text-white' : 'bg-slate-700 text-slate-200')}>
                      {msg.content}
                    </div>
                  </div>
                ))}
                {chatLoading && (
                  <div className="flex justify-start">
                    <div className="bg-slate-700 px-3 py-2 rounded-xl flex gap-1">
                      {[0, 150, 300].map(d => (
                        <div key={d} className="w-1.5 h-1.5 bg-slate-400 rounded-full animate-bounce" style={{ animationDelay: d + 'ms' }} />
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
            <div className="flex gap-2">
              <input
                type="text"
                value={chatMsg}
                onChange={e => setChatMsg(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleChat()}
                placeholder="Bijv. welk product heeft de hoogste marge?"
                className="flex-1 bg-slate-900/60 border border-slate-700 rounded-xl px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
              />
              <button
                onClick={handleChat}
                disabled={!chatMsg.trim() || chatLoading}
                className="bg-brand-600 hover:bg-brand-700 disabled:opacity-50 text-white p-2 rounded-xl transition-colors"
              >
                <Send className="w-4 h-4" />
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
