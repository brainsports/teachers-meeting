import React, { useState } from 'react';
import {
  Calendar,
  MapPin,
  Users,
  ClipboardList,
  Loader2,
  CheckCircle2,
  AlertCircle,
  FileText,
  Upload,
  Sparkles,
  Download,
  RotateCcw,
  Pencil,
  X,
  NotebookPen,
  ClipboardPaste,
  Wand2,
  FileUp,
  Info,
} from 'lucide-react';
import { Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell, WidthType, AlignmentType, VerticalAlign } from 'docx';
import { saveAs } from 'file-saver';

// Types
interface MeetingData {
  title: string;
  date: string;
  location: string;
  attendees: string;
  memo: string;
}

interface Sections {
  report: string;
  agenda: string;
  discussion: string;
  nextWeek: string;
  supervision: string;
}

interface UsageInfo {
  usageCount: number;
  remaining: number;
  limit: number;
}

const EMPTY_SECTIONS: Sections = {
  report: '',
  agenda: '',
  discussion: '',
  nextWeek: '',
  supervision: '',
};

const INITIAL_USAGE: UsageInfo = { usageCount: 0, remaining: 3, limit: 3 };

const SECTION_LABELS: { key: keyof Sections; label: string; hint: string }[] = [
  { key: 'report', label: '보고 및 전달사항', hint: '공지, 행정, 일정, 아동 관련 전달사항' },
  { key: 'agenda', label: '안건', hint: '논의할 주제 (번호별)' },
  { key: 'discussion', label: '회의내용', hint: '안건별 논의내용 · 결정사항 · 담당자 · 일정' },
  { key: 'nextWeek', label: '기타(차주계획)', hint: '다음 주 프로그램 · 행사 · 준비사항' },
  { key: 'supervision', label: '슈퍼비전', hint: '센터장 · 관리자의 지도와 조언' },
];

// 진행 단계 표시
const STEPS = ['① 회의자료 입력', '② 기본정보 입력', '③ 회의내용 작성', '④ AI 회의록 생성', '⑤ 다운로드'];

// 초기 일시 기본값 (현재 시각) — useState 초기화와 동일한 계산
const initialDate = (() => {
  const now = new Date();
  now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
  return now.toISOString().slice(0, 16);
})();

// Utility to strip markdown characters like **, ###, etc.
const stripMarkdown = (text: string) => {
  if (!text) return '';
  return text
    .replace(/\*\*/g, '')
    .replace(/###/g, '')
    .replace(/##/g, '')
    .replace(/#/g, '')
    .replace(/^- /gm, '')
    .replace(/^\* /gm, '')
    .replace(/---/g, '')
    .replace(/`/g, '')
    .replace(/_/g, '')
    .trim();
};

export default function App() {
  const [processing, setProcessing] = useState(false);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [editingSection, setEditingSection] = useState<keyof Sections | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const [usage, setUsage] = useState<UsageInfo>(INITIAL_USAGE);

  const [meetingData, setMeetingData] = useState<MeetingData>({
    title: '교사회의',
    date: initialDate,
    location: '',
    attendees: '',
    memo: '',
  });

  // 붙여넣은 회의자료 텍스트 (자동배치 원본)
  const [pastedText, setPastedText] = useState('');

  const [sections, setSections] = useState<Sections>(EMPTY_SECTIONS);

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setMeetingData(prev => ({ ...prev, [name]: value }));
  };

  const handleFileUpload = async (file: File | undefined) => {
    if (!file) return;

    setError(null);

    const isAllowed =
      ['application/pdf', 'text/plain'].includes(file.type) ||
      file.name.toLowerCase().endsWith('.pdf') ||
      file.name.toLowerCase().endsWith('.txt') ||
      file.name.toLowerCase().endsWith('.docx');
    if (!isAllowed) {
      setError('PDF · TXT · Word(DOCX) 파일만 업로드 가능합니다.');
      return;
    }

    // DOCX: extract text client-side and send as plain text so the
    // Gemini document flow (text/plain) works unchanged.
    if (file.name.toLowerCase().endsWith('.docx')) {
      try {
        const { extractDocxText } = await import('./docxExtract');
        const text = await extractDocxText(file);
        if (!text) {
          setError('Word(DOCX) 문서에서 텍스트를 추출할 수 없습니다.');
          return;
        }
        setUploadedFileName(file.name);
        setSelectedFile(new File([text], file.name.replace(/\.docx$/i, '.txt'), { type: 'text/plain' }));
        return;
      } catch (err) {
        console.error(err);
        setError('Word(DOCX) 파일을 읽는 중 오류가 발생했습니다.');
        return;
      }
    }

    setUploadedFileName(file.name);
    setSelectedFile(file);
  };

  const readFileAsBase64 = (file: File): Promise<{ base64Data: string; mimeType: string }> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = reader.result as string;
        const parts = result.split(',');
        resolve({ base64Data: parts[1], mimeType: file.type || 'application/pdf' });
      };
      reader.onerror = err => reject(err);
      reader.readAsDataURL(file);
    });
  };

  // 회의자료 텍스트 → AI 분석 → 입력란 자동배치
  const analyzePastedText = async () => {
    if (!pastedText.trim()) {
      setError('붙여넣은 회의자료 텍스트가 없습니다.');
      return;
    }

    setAnalyzing(true);
    setError(null);
    setNotice(null);

    try {
      const response = await fetch('/api/analyze-meeting-text', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: pastedText }),
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        setError(data.message || '텍스트 분석 중 오류가 발생했습니다.');
        setAnalyzing(false);
        return;
      }

      const fields = (data.fields || {}) as Record<string, string>;
      let filledCount = 0;

      // --- meetingData: 회의명/일시/장소/참석자 자동배치 ---
      // 기본값(초기 자동 설정된 '교사회의', 현재 일시)은 사용자가 직접 쓴 값이
      // 아니므로 텍스트에 실제 값이 있으면 덮어쓴다. 나머지는 빈 값일 때만 채운다.
      const TITLE_DEFAULT = '교사회의';
      const DATE_DEFAULT = initialDate;
      setMeetingData(prev => {
        const next = { ...prev };
        const assign = (key: 'title' | 'date' | 'location' | 'attendees', v: string | undefined, isDefault: boolean) => {
          if (!v) return;
          const cur = prev[key].trim();
          const empty = cur === '';
          // 기본값 상태이거나 빈 값일 때만 자동배치 (사용자 수정값 보호)
          if (empty || (isDefault && cur === (key === 'title' ? TITLE_DEFAULT : DATE_DEFAULT))) {
            next[key] = v;
            filledCount += 1;
          }
        };
        assign('title', fields.title, true);
        assign('date', fields.date, true);
        assign('location', fields.location, false);
        assign('attendees', fields.attendees, false);
        return next;
      });

      // --- sections: 보고/안건/회의내용/차주계획/슈퍼비전 자동배치 ---
      // AI 생성 결과가 없는 상태(빈 값)일 때만 채운다 — 이미 생성·수정된 회의록 보호
      setSections(prev => {
        const next = { ...prev };
        for (const key of ['report', 'agenda', 'discussion', 'nextWeek', 'supervision'] as const) {
          const v = fields[key];
          if (v && !prev[key].trim()) {
            next[key] = v;
            filledCount += 1;
          }
        }
        return next;
      });

      setNotice(
        filledCount > 0
          ? `AI가 ${filledCount}개 항목을 자동으로 채웠습니다. 값을 확인하고 수정할 수 있습니다.`
          : '이미 입력된 값이 있어 자동배치를 건너뛴 항목이 있습니다. 직접 확인해 주세요.'
      );
      setAnalyzing(false);
    } catch (err) {
      console.error(err);
      setError('서버 통신 중 오류가 발생했습니다.');
      setAnalyzing(false);
    }
  };

  const generateMinutes = async () => {
    if (processing) return; // 동시 클릭 방지
    if (!selectedFile && !meetingData.memo.trim()) {
      setError('회의 메모를 입력하거나 자료를 업로드해 주세요.');
      return;
    }

    setProcessing(true);
    setError(null);

    try {
      let filePayload = null;
      if (selectedFile) {
        const fileInfo = await readFileAsBase64(selectedFile);
        filePayload = {
          mimeType: fileInfo.mimeType,
          base64Data: fileInfo.base64Data,
          name: selectedFile.name,
        };
      }

      const response = await fetch('/api/generate-teacher-minutes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ file: filePayload, meetingData }),
      });

      const data = await response.json();

      if (!response.ok || data.error) {
        if (data.error === 'USAGE_LIMIT_EXCEEDED') {
          setUsage(prev => ({ ...prev, usageCount: prev.limit, remaining: 0 }));
        }
        if (data.usageInfo) {
          setUsage(data.usageInfo);
        }
        setError(data.message || '회의록 생성 처리 중 오류가 발생했습니다.');
        setProcessing(false);
        return;
      }

      setSections({
        report: data.sections?.report || '',
        agenda: data.sections?.agenda || '',
        discussion: data.sections?.discussion || '',
        nextWeek: data.sections?.nextWeek || '',
        supervision: data.sections?.supervision || '',
      });
      if (data.usageInfo) {
        setUsage(data.usageInfo);
      } else {
        // 서버가 usageInfo를 주지 않은 경우 로컬 추정 (정상 응답 시에만)
        setUsage(prev => ({ ...prev, usageCount: Math.min(prev.limit, prev.usageCount + 1), remaining: Math.max(0, prev.remaining - 1) }));
      }
      setProcessing(false);
    } catch (err) {
      console.error(err);
      setError('서버 통신 중 오류가 발생했습니다.');
      setProcessing(false);
    }
  };

  const startEdit = (key: keyof Sections) => {
    setEditingSection(key);
    setEditDraft(sections[key]);
  };

  const saveEdit = () => {
    if (editingSection) {
      setSections(prev => ({ ...prev, [editingSection]: editDraft }));
    }
    setEditingSection(null);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    if (!processing) setIsDragging(true);
  };

  const handleDragLeave = () => setIsDragging(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragging(false);
    if (processing) return;
    const file = e.dataTransfer.files?.[0];
    if (file) handleFileUpload(file);
  };

  const hasResult = Object.values(sections).some(v => v.trim() !== '');

  // A4 페이지 분할 — 첫 장은 제목+기본정보로 좁고, 이후 장은 본문 전용.
  // 항목(행) 단위로만 넘기므로 발언 블록이 중간에 잘리지 않는다.
  // 한 장당 들어갈 수 있는 본문 글자량(경험적 추정): 1페이지 1400자, 2페이지부터 2400자
  const pages: { key: keyof Sections; label: string; hint: string }[][] = (() => {
    const visible = processing ? [] : SECTION_LABELS.slice();
    const chunks: typeof pages = [];
    let current: typeof visible = [];
    let used = 0;
    const capacity = () => (chunks.length === 0 ? 1400 : 2400);
    for (const item of visible) {
      const len = stripMarkdown(sections[item.key] || '').length + 60;
      if (used > 0 && used + len > capacity()) {
        chunks.push(current);
        current = [];
        used = 0;
      }
      current.push(item);
      used += len;
    }
    if (current.length > 0 || chunks.length === 0) chunks.push(current);
    return chunks;
  })();

  const downloadWord = async () => {
    const formatDateTime = (value: string) => value.replace('T', ' ');
    const toLines = (text: string) =>
      stripMarkdown(text)
        .split('\n')
        .map(line => new Paragraph({ text: line, alignment: AlignmentType.JUSTIFIED, spacing: { after: 120 } }));

    const doc = new Document({
      sections: [
        {
          properties: {
            // A4 with uniform 1.0cm margins on all four sides
            page: {
              size: { width: 11906, height: 16838 },
              margin: { top: 567, bottom: 567, left: 567, right: 567 },
            },
          },
          children: [
            new Paragraph({
              alignment: AlignmentType.CENTER,
              children: [new TextRun({ text: meetingData.title || '교사회의록', bold: true, size: 32 })],
            }),
            new Paragraph({ text: '' }),
            new Table({
              width: { size: 100, type: WidthType.PERCENTAGE },
              rows: [
                // 기본정보: 일시 / 장소
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: '일 시', bold: true })], alignment: AlignmentType.CENTER })], verticalAlign: VerticalAlign.CENTER }),
                    new TableCell({ columnSpan: 3, children: [new Paragraph({ text: formatDateTime(meetingData.date), alignment: AlignmentType.CENTER })], verticalAlign: VerticalAlign.CENTER }),
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: '장 소', bold: true })], alignment: AlignmentType.CENTER })], verticalAlign: VerticalAlign.CENTER }),
                    new TableCell({ columnSpan: 3, children: [new Paragraph({ text: meetingData.location, alignment: AlignmentType.CENTER })], verticalAlign: VerticalAlign.CENTER }),
                  ],
                }),
                // 기본정보: 참석자
                new TableRow({
                  children: [
                    new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: '참석자', bold: true })], alignment: AlignmentType.CENTER })], verticalAlign: VerticalAlign.CENTER }),
                    new TableCell({ columnSpan: 7, children: [new Paragraph({ text: meetingData.attendees, alignment: AlignmentType.CENTER })], verticalAlign: VerticalAlign.CENTER }),
                  ],
                }),
                // 본문 5개 항목
                ...SECTION_LABELS.map(
                  ({ key, label }) =>
                    new TableRow({
                      children: [
                        new TableCell({
                          children: [new Paragraph({ children: [new TextRun({ text: label, bold: true })], alignment: AlignmentType.CENTER })],
                          verticalAlign: VerticalAlign.CENTER,
                          shading: { fill: 'F5F5F5' },
                        }),
                        new TableCell({
                          columnSpan: 7,
                          children: sections[key] ? toLines(sections[key]) : [new Paragraph({ text: '' })],
                          verticalAlign: VerticalAlign.TOP,
                        }),
                      ],
                    })
                ),
              ],
            }),
          ],
        },
      ],
    });

    const blob = await Packer.toBlob(doc);
    const dateForName = meetingData.date.replace('T', '_').replace(/[:]/g, '-');
    saveAs(blob, `교사회의록_${dateForName}.docx`);
  };

  const limitReached = usage.remaining <= 0;

  return (
    <div className="min-h-screen bg-[#eefbf7] font-sans">
      {/* Header — 제목 클릭 시 랜딩페이지로 이동 */}
      <header className="bg-white/90 backdrop-blur border-b border-teal-100 sticky top-0 z-40 shadow-sm">
        <div className="w-full px-3 lg:px-5 h-16 flex items-center justify-between gap-4">
          <a href="/teachers-meeting/" className="flex items-center gap-3 min-w-0 group" title="랜딩페이지로 이동">
            <span className="w-10 h-10 rounded-2xl bg-teal-500 flex items-center justify-center shadow-sm group-hover:bg-teal-600 transition-colors">
              <NotebookPen className="w-5.5 h-5.5 text-white" />
            </span>
            <h1 className="font-bold text-lg lg:text-xl text-teal-900 truncate group-hover:text-teal-600 transition-colors cursor-pointer">
              교사회의록 AI 작성도우미
            </h1>
          </a>
          <button
            onClick={downloadWord}
            disabled={!hasResult}
            className={`flex items-center gap-2 px-4 lg:px-6 py-2.5 rounded-full text-sm font-bold transition-all whitespace-nowrap ${
              hasResult
                ? 'bg-blue-600 text-white hover:bg-blue-700 shadow-md shadow-blue-200'
                : 'bg-slate-100 text-slate-300 cursor-not-allowed'
            }`}
          >
            <Download className="w-4 h-4" />
            Word 다운로드
          </button>
        </div>

        {/* 진행 단계 표시 */}
        <div className="w-full px-3 lg:px-5 pb-3 -mt-1 hidden md:block">
          <div className="flex items-center gap-2 text-[13px] font-medium">
            {STEPS.map((step, i) => (
              <React.Fragment key={step}>
                <span
                  className={`px-3 py-1 rounded-full whitespace-nowrap ${
                    i === 0 || i === 1
                      ? 'bg-teal-500 text-white'
                      : i === 2 || i === 3
                        ? 'bg-teal-100 text-teal-700'
                        : 'bg-slate-100 text-slate-400'
                  }`}
                >
                  {step}
                </span>
                {i < STEPS.length - 1 && <span className="text-slate-300">→</span>}
              </React.Fragment>
            ))}
          </div>
        </div>
      </header>

      <main className="w-full px-2 lg:px-4 py-6 lg:py-8 grid grid-cols-1 lg:grid-cols-[30fr_70fr] gap-6 lg:gap-6 items-start">
        {/* Left: 입력 카드 */}
        <div className="bg-white rounded-3xl border border-teal-100/80 shadow-[0_4px_24px_rgba(13,148,136,0.08)] p-5 lg:p-6 space-y-7 min-w-0">
          {/* ① 회의자료 입력 */}
          <section className="space-y-4">
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-xl bg-teal-100 text-teal-600 flex items-center justify-center">
                <FileUp className="w-4 h-4" />
              </span>
              <h2 className="font-bold text-teal-900">회의자료 입력</h2>
            </div>

            {/* 업로드 영역 — 넓고 강조 */}
            <label
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`w-full py-10 rounded-2xl font-bold flex flex-col items-center justify-center gap-3 cursor-pointer transition-all border-2 border-dashed ${
                isDragging
                  ? 'border-teal-500 bg-teal-50 scale-[1.01]'
                  : processing
                    ? 'bg-slate-50 text-slate-300 border-transparent'
                    : 'bg-teal-50/60 text-teal-700 hover:bg-teal-50 border-teal-300'
              }`}
            >
              <div className="w-12 h-12 rounded-2xl bg-white shadow-sm flex items-center justify-center">
                {processing ? <Loader2 className="w-6 h-6 animate-spin text-teal-400" /> : <Upload className="w-6 h-6 text-teal-500" />}
              </div>
              <div className="text-base">{processing ? '분석 중...' : '회의자료 파일 업로드'}</div>
              <span className="text-xs text-teal-500/70 font-normal">PDF · TXT · Word(DOCX) — 파일을 드래그하여 놓으세요</span>
              <input
                type="file"
                accept="application/pdf,text/plain,.pdf,.txt,.docx"
                onChange={e => handleFileUpload(e.target.files?.[0])}
                disabled={processing}
                className="hidden"
              />
            </label>

            {uploadedFileName && (
              <div className="flex items-center gap-3 px-4 py-3 bg-teal-50 rounded-xl border border-teal-100">
                <Upload className="w-4 h-4 text-teal-500 shrink-0" />
                <span className="text-sm text-teal-800 truncate flex-1 font-medium">{uploadedFileName}</span>
                {!processing && (
                  <button
                    onClick={() => {
                      setSelectedFile(null);
                      setUploadedFileName(null);
                    }}
                    className="p-1.5 hover:bg-teal-100 rounded-full transition-all"
                    title="파일 삭제"
                  >
                    <X className="w-4 h-4 text-teal-500" />
                  </button>
                )}
              </div>
            )}

            {/* 텍스트 붙여넣기 */}
            <div className="space-y-2">
              <div className="flex items-center gap-2">
                <ClipboardPaste className="w-4 h-4 text-teal-500" />
                <label className="text-sm font-bold text-teal-800">회의자료 텍스트 붙여넣기</label>
              </div>
              <textarea
                value={pastedText}
                onChange={e => setPastedText(e.target.value)}
                rows={7}
                placeholder={'회의자료 전체를 그대로 붙여넣으세요.\n\n예)\n회의명: 9월 교사회의\n일시: 2026년 9월 10일 오후 2시\n장소: 센터 회의실\n참석자: 김센터장, 박교사, 이교사\n보고 및 전달사항: 추석 행사 준비\n안건: 2학기 프로그램 운영 논의\n회의내용: ...\n기타: 다음 주 체험활동 준비\n슈퍼비전: 아동지도 시 안전관리를 강화하기로 함'}
                className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl text-[15px] focus:ring-2 focus:ring-teal-400 focus:border-teal-300 outline-none transition-all resize-y leading-relaxed"
              />
              <button
                onClick={analyzePastedText}
                disabled={analyzing || !pastedText.trim()}
                className={`w-full py-3.5 rounded-2xl font-bold text-[15px] flex items-center justify-center gap-2 transition-all ${
                  analyzing || !pastedText.trim()
                    ? 'bg-slate-100 text-slate-300 cursor-not-allowed'
                    : 'bg-white border-2 border-teal-400 text-teal-600 hover:bg-teal-50 shadow-sm'
                }`}
              >
                {analyzing ? <Loader2 className="w-4.5 h-4.5 animate-spin" /> : <Wand2 className="w-4.5 h-4.5" />}
                {analyzing ? 'AI가 분석 중...' : 'AI 자동배치'}
              </button>
              <p className="text-xs text-slate-400 leading-relaxed flex items-start gap-1.5">
                <Info className="w-3.5 h-3.5 mt-px shrink-0" />
                붙여넣은 텍스트를 AI가 분석해 회의정보 입력란에 자동으로 채웁니다. 이미 직접 입력한 값은 덮어쓰지 않습니다.
              </p>
            </div>

            {notice && (
              <div className="p-4 bg-teal-50 border border-teal-100 rounded-2xl flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-teal-500 shrink-0 mt-0.5" />
                <span className="text-sm text-teal-700 leading-snug">{notice}</span>
              </div>
            )}
            {error && (
              <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-400 shrink-0 mt-0.5" />
                <span className="text-sm text-red-600 leading-snug">{error}</span>
              </div>
            )}
          </section>

          {/* ② 기본정보 입력 */}
          <section className="space-y-5 pt-2 border-t border-slate-100">
            <div className="flex items-center gap-2 pt-4">
              <span className="w-7 h-7 rounded-xl bg-teal-100 text-teal-600 flex items-center justify-center">
                <ClipboardList className="w-4 h-4" />
              </span>
              <h2 className="font-bold text-teal-900">기본정보 입력</h2>
            </div>

            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-500 flex items-center gap-2">
                <NotebookPen className="w-4 h-4 text-teal-400" /> 회의명
              </label>
              <input
                type="text"
                name="title"
                placeholder="예: 9월 정기 교사회의"
                value={meetingData.title}
                onChange={handleInputChange}
                className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl text-base focus:ring-2 focus:ring-teal-400 focus:border-teal-300 outline-none transition-all"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-500 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-teal-400" /> 일시
              </label>
              <input
                type="datetime-local"
                name="date"
                value={meetingData.date}
                onChange={handleInputChange}
                className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl text-base focus:ring-2 focus:ring-teal-400 focus:border-teal-300 outline-none transition-all"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-500 flex items-center gap-2">
                <MapPin className="w-4 h-4 text-teal-400" /> 장소
              </label>
              <input
                type="text"
                name="location"
                placeholder="예: ○○지역아동센터 교사실"
                value={meetingData.location}
                onChange={handleInputChange}
                className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl text-base focus:ring-2 focus:ring-teal-400 focus:border-teal-300 outline-none transition-all"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-500 flex items-center gap-2">
                <Users className="w-4 h-4 text-teal-400" /> 참석자
              </label>
              <input
                type="text"
                name="attendees"
                placeholder="예: 김센터장, 박교사, 이교사"
                value={meetingData.attendees}
                onChange={handleInputChange}
                className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl text-base focus:ring-2 focus:ring-teal-400 focus:border-teal-300 outline-none transition-all"
              />
            </div>

            {/* ③ 회의내용 작성(메모) */}
            <div className="space-y-2">
              <label className="text-sm font-bold text-slate-500 flex items-center gap-2">
                <ClipboardList className="w-4 h-4 text-teal-400" /> 회의 핵심 메모 / 안건
              </label>
              <textarea
                name="memo"
                rows={6}
                placeholder={'짧은 메모도 괜찮습니다.\n예: 가을 야유회 장소 결정, 김민수 학교 적응 관련 논의, 다음 주 소방교육 준비'}
                value={meetingData.memo}
                onChange={handleInputChange}
                className="w-full p-4 bg-slate-50 border border-slate-200 rounded-2xl text-base focus:ring-2 focus:ring-teal-400 focus:border-teal-300 outline-none transition-all resize-none leading-relaxed"
              />
              <p className="text-xs text-slate-400 leading-relaxed">AI가 입력된 내용만 바탕으로 항목별로 분류하여 작성합니다. 없는 사실은 만들지 않습니다.</p>
            </div>
          </section>

          {/* ④ AI 회의록 생성 */}
          <section className="space-y-3 pt-2 border-t border-slate-100">
            <div className="flex items-center justify-between pt-4 flex-wrap gap-2">
              <div className="flex items-center gap-2">
                <span className="w-7 h-7 rounded-xl bg-blue-100 text-blue-600 flex items-center justify-center">
                  <Sparkles className="w-4 h-4" />
                </span>
                <h2 className="font-bold text-teal-900">AI 회의록 생성</h2>
              </div>
              {/* 남은 횟수 표시 */}
              <span className={`px-3 py-1.5 rounded-full text-[13px] font-bold flex items-center gap-1.5 ${limitReached ? 'bg-red-50 text-red-500 border border-red-100' : 'bg-teal-50 text-teal-600 border border-teal-100'}`}>
                <CheckCircle2 className="w-3.5 h-3.5" />
                오늘 AI 회의록 생성 {usage.usageCount}/{usage.limit}회 · {usage.remaining}회 남음
              </span>
            </div>

            {limitReached && (
              <div className="p-4 bg-red-50 border border-red-100 rounded-2xl text-sm text-red-600 leading-relaxed">
                오늘 사용 가능한 AI 회의록 3회를 모두 사용했습니다. 내일 다시 이용할 수 있습니다.
              </div>
            )}

            <button
              onClick={generateMinutes}
              disabled={processing || (!selectedFile && !meetingData.memo.trim()) || limitReached}
              className={`w-full py-5 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 transition-all ${
                processing || (!selectedFile && !meetingData.memo.trim()) || limitReached
                  ? 'bg-slate-100 text-slate-300 cursor-not-allowed'
                  : 'bg-blue-600 text-white hover:bg-blue-700 shadow-lg shadow-blue-200 hover:scale-[1.01] active:scale-[0.99]'
              }`}
            >
              {processing ? <Loader2 className="w-6 h-6 animate-spin" /> : hasResult ? <RotateCcw className="w-6 h-6" /> : <Sparkles className="w-6 h-6" />}
              {hasResult ? '다시 생성' : 'AI로 회의록 작성하기'}
            </button>
            <p className="text-xs text-slate-400 text-center leading-relaxed">생성 후 각 항목에서 내용을 직접 수정할 수 있습니다.</p>
          </section>
        </div>

        {/* Right: A4 미리보기 작업 공간 (연한 회색 캔버스) */}
        <div className="a4-workspace min-w-0">
          <div className="flex items-center justify-between gap-3 flex-wrap px-1 pb-3">
            <div className="flex items-center gap-2">
              <span className="w-7 h-7 rounded-xl bg-teal-100 text-teal-600 flex items-center justify-center">
                <FileText className="w-4 h-4" />
              </span>
              <h2 className="font-bold text-teal-900">회의록 미리보기</h2>
            </div>
            {hasResult && (
              <span className="px-3 py-1 bg-white border border-blue-100 rounded-full text-blue-600 text-[13px] font-medium flex items-center gap-1.5 shadow-sm">
                <CheckCircle2 className="w-4 h-4" />
                생성 완료 · 수정 가능
              </span>
            )}
          </div>

          {/* A4 문서들 (길면 여러 장) — 작업 공간 중앙에 배치 */}
          <div className="a4-pages">
            {pages.map((pageRows, pageIdx) => (
              <div key={pageIdx} className="a4-sheet">
                {/* 1페이지에만 제목 표시 */}
                {pageIdx === 0 && (
                  <h3 className="a4-doc-title">{meetingData.title || '교사회의록'}</h3>
                )}

                <div className="a4-table">
                  {pageIdx === 0 && (
                    <>
                      {/* 기본정보: 일시 / 장소 */}
                      <div className="flex">
                        <div className="a4-cell-label">일 시</div>
                        <div className="a4-cell-value w-2/6">{meetingData.date.replace('T', ' ')}</div>
                        <div className="a4-cell-label">장 소</div>
                        <div className="a4-cell-value w-2/6">{meetingData.location}</div>
                      </div>
                      {/* 기본정보: 참석자 */}
                      <div className="flex">
                        <div className="a4-cell-label">참석자</div>
                        <div className="a4-cell-value w-5/6">{meetingData.attendees}</div>
                      </div>
                    </>
                  )}

                  {processing ? (
                    <div className="a4-cell-body min-h-[400px] flex flex-col items-center justify-center gap-6 text-slate-400">
                      <Loader2 className="w-10 h-10 animate-spin text-blue-500" />
                      <p className="text-base font-medium">AI가 회의 내용을 분석하고 있습니다...</p>
                    </div>
                  ) : (
                    pageRows.map(({ key, label, hint }) => (
                      <div key={key} className="flex group relative">
                        <div className="a4-cell-label w-1/6 leading-snug">{label}</div>
                        <div className="a4-cell-body w-5/6">
                          {editingSection === key ? (
                            <div className="w-full space-y-3">
                              <textarea
                                value={editDraft}
                                onChange={e => setEditDraft(e.target.value)}
                                rows={8}
                                autoFocus
                                className="w-full p-3 bg-slate-50 border border-slate-300 rounded-xl text-base focus:ring-2 focus:ring-teal-400 outline-none leading-relaxed resize-y"
                              />
                              <div className="flex gap-2 justify-end">
                                <button
                                  onClick={() => setEditingSection(null)}
                                  className="px-4 py-2 rounded-xl border border-slate-200 text-slate-500 text-sm font-bold hover:bg-slate-50"
                                >
                                  취소
                                </button>
                                <button onClick={saveEdit} className="px-4 py-2 rounded-xl bg-teal-500 text-white text-sm font-bold hover:bg-teal-600">
                                  저장
                                </button>
                              </div>
                            </div>
                          ) : sections[key] ? (
                            stripMarkdown(sections[key])
                          ) : (
                            <span className="text-slate-300">{hasResult ? '내용 없음 — 직접 입력할 수 있습니다.' : hint}</span>
                          )}
                        </div>
                        {editingSection !== key && (
                          <button
                            onClick={() => startEdit(key)}
                            title={`${label} 수정`}
                            className="absolute right-3 top-3 p-2 rounded-full bg-slate-100 text-slate-400 hover:bg-teal-500 hover:text-white opacity-0 group-hover:opacity-100 transition-all shadow-sm"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>
                    ))
                  )}
                </div>

                {!hasResult && !processing && pageIdx === 0 && (
                  <p className="text-center text-sm text-slate-400 leading-relaxed mt-8">
                    회의 메모를 입력하고 <span className="font-bold text-teal-600">AI로 회의록 작성하기</span> 버튼을 누르면
                    <br />
                    5개 항목으로 구성된 교사회의록이 자동 작성됩니다.
                  </p>
                )}

                {pages.length > 1 && (
                  <div className="a4-page-number">{pageIdx + 1} / {pages.length} 페이지</div>
                )}
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}
