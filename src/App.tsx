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

const EMPTY_SECTIONS: Sections = {
  report: '',
  agenda: '',
  discussion: '',
  nextWeek: '',
  supervision: '',
};

const SECTION_LABELS: { key: keyof Sections; label: string; hint: string }[] = [
  { key: 'report', label: '보고 및 전달사항', hint: '공지, 행정, 일정, 아동 관련 전달사항' },
  { key: 'agenda', label: '안건', hint: '논의할 주제 (번호별)' },
  { key: 'discussion', label: '회의내용', hint: '안건별 논의내용 · 결정사항 · 담당자 · 일정' },
  { key: 'nextWeek', label: '기타(차주계획)', hint: '다음 주 프로그램 · 행사 · 준비사항' },
  { key: 'supervision', label: '슈퍼비전', hint: '센터장 · 관리자의 지도와 조언' },
];

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
  const [error, setError] = useState<string | null>(null);
  const [uploadedFileName, setUploadedFileName] = useState<string | null>(null);
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [editingSection, setEditingSection] = useState<keyof Sections | null>(null);
  const [editDraft, setEditDraft] = useState('');

  const [meetingData, setMeetingData] = useState<MeetingData>({
    title: '교사회의',
    date: (() => {
      const now = new Date();
      now.setMinutes(now.getMinutes() - now.getTimezoneOffset());
      return now.toISOString().slice(0, 16);
    })(),
    location: '',
    attendees: '',
    memo: '',
  });

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

  const generateMinutes = async () => {
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
                          children: sections[key]
                            ? toLines(sections[key])
                            : [new Paragraph({ text: '' })],
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

  return (
    <div className="min-h-screen bg-stone-50 font-sans">
      {/* Header */}
      <header className="bg-white border-b border-stone-200 sticky top-0 z-40 shadow-sm">
        <div className="max-w-7xl mx-auto px-4 lg:px-8 h-16 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <NotebookPen className="w-6 h-6 text-brand-green shrink-0" />
            <h1 className="font-bold text-lg lg:text-xl truncate">교사회의록 AI 작성도우미</h1>
          </div>
          <button
            onClick={downloadWord}
            disabled={!hasResult}
            className={`flex items-center gap-2 px-4 lg:px-6 py-2.5 rounded-full text-sm font-bold transition-all whitespace-nowrap ${
              hasResult
                ? 'bg-white border-2 border-brand-green text-brand-green hover:bg-brand-green hover:text-white shadow-md'
                : 'bg-stone-100 text-stone-300 border-2 border-stone-100 cursor-not-allowed'
            }`}
          >
            <Download className="w-4 h-4" />
            Word 다운로드
          </button>
        </div>
      </header>

      <main className="max-w-7xl mx-auto px-4 lg:px-8 py-8 lg:py-12 grid grid-cols-1 lg:grid-cols-5 gap-8 lg:gap-10">
        {/* Left: Step 1 + Step 2 */}
        <div className="lg:col-span-2 space-y-8">
          {/* Step 1. 회의자료 업로드 */}
          <section className="bg-white rounded-3xl border border-stone-200 shadow-sm p-6 lg:p-8 space-y-4">
            <div className="space-y-1">
              <span className="text-xs font-bold text-brand-green uppercase tracking-widest">Step 1. 회의자료 업로드</span>
              <p className="text-[13px] text-stone-500 leading-relaxed">PDF · TXT · Word(DOCX) 파일을 업로드하세요. 자료가 없어도 메모만으로 생성할 수 있습니다.</p>
            </div>

            <label
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
              className={`w-full py-8 rounded-2xl font-bold flex flex-col items-center justify-center gap-3 cursor-pointer transition-all border-2 border-dashed ${
                isDragging
                  ? 'border-brand-green bg-brand-green/5 scale-[1.02]'
                  : processing
                    ? 'bg-stone-50 text-stone-200 border-transparent'
                    : 'bg-white text-stone-700 hover:bg-brand-green/5 border-stone-200 shadow-sm'
              }`}
            >
              <div className="flex items-center gap-3 text-lg">
                {processing ? <Loader2 className="w-5 h-5 animate-spin" /> : <FileText className="w-5 h-5" />}
                {processing ? '분석 중...' : '회의자료 업로드'}
              </div>
              {!processing && <span className="text-xs text-stone-400 font-normal">파일을 드래그하여 놓으세요</span>}
              <input
                type="file"
                accept="application/pdf,text/plain,.pdf,.txt,.docx"
                onChange={e => handleFileUpload(e.target.files?.[0])}
                disabled={processing}
                className="hidden"
              />
            </label>

            {uploadedFileName && (
              <div className="flex items-center gap-3 px-4 py-3 bg-brand-green/5 rounded-xl border border-brand-green/10 group">
                <Upload className="w-4 h-4 text-brand-green shrink-0" />
                <span className="text-sm text-stone-600 truncate flex-1 font-medium">{uploadedFileName}</span>
                {!processing && (
                  <button
                    onClick={() => {
                      setSelectedFile(null);
                      setUploadedFileName(null);
                    }}
                    className="p-1.5 hover:bg-brand-green/10 rounded-full transition-all"
                    title="파일 삭제"
                  >
                    <X className="w-4 h-4 text-brand-green" />
                  </button>
                )}
              </div>
            )}

            {error && (
              <div className="p-4 bg-red-50 border border-red-100 rounded-2xl flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
                <span className="text-sm text-red-600 leading-snug">{error}</span>
              </div>
            )}
          </section>

          {/* Step 2. 회의정보 입력 */}
          <section className="bg-white rounded-3xl border border-stone-200 shadow-sm p-6 lg:p-8 space-y-5">
            <span className="text-xs font-bold text-brand-green uppercase tracking-widest block">Step 2. 회의정보 입력</span>

            <div className="space-y-2">
              <label className="text-sm font-bold text-stone-500 flex items-center gap-2">
                <ClipboardList className="w-4 h-4" /> 회의명
              </label>
              <input
                type="text"
                name="title"
                placeholder="예: 9월 정기 교사회의"
                value={meetingData.title}
                onChange={handleInputChange}
                className="w-full p-4 bg-stone-50 border border-stone-200 rounded-2xl text-base focus:ring-2 focus:ring-brand-green outline-none transition-all"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-bold text-stone-500 flex items-center gap-2">
                <Calendar className="w-4 h-4" /> 일시
              </label>
              <input
                type="datetime-local"
                name="date"
                value={meetingData.date}
                onChange={handleInputChange}
                className="w-full p-4 bg-stone-50 border border-stone-200 rounded-2xl text-base focus:ring-2 focus:ring-brand-green outline-none transition-all"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-bold text-stone-500 flex items-center gap-2">
                <MapPin className="w-4 h-4" /> 장소
              </label>
              <input
                type="text"
                name="location"
                placeholder="예: ○○지역아동센터 교사실"
                value={meetingData.location}
                onChange={handleInputChange}
                className="w-full p-4 bg-stone-50 border border-stone-200 rounded-2xl text-base focus:ring-2 focus:ring-brand-green outline-none transition-all"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-bold text-stone-500 flex items-center gap-2">
                <Users className="w-4 h-4" /> 참석자
              </label>
              <input
                type="text"
                name="attendees"
                placeholder="예: 김센터장, 박교사, 이교사"
                value={meetingData.attendees}
                onChange={handleInputChange}
                className="w-full p-4 bg-stone-50 border border-stone-200 rounded-2xl text-base focus:ring-2 focus:ring-brand-green outline-none transition-all"
              />
            </div>

            <div className="space-y-2">
              <label className="text-sm font-bold text-stone-500 flex items-center gap-2">
                <ClipboardList className="w-4 h-4" /> 회의 핵심 메모 / 안건
              </label>
              <textarea
                name="memo"
                rows={6}
                placeholder={'짧은 메모도 괜찮습니다.\n예: 가을 야유회 장소 결정, 김민수 학교 적응 관련 논의, 다음 주 소방교육 준비'}
                value={meetingData.memo}
                onChange={handleInputChange}
                className="w-full p-4 bg-stone-50 border border-stone-200 rounded-2xl text-base focus:ring-2 focus:ring-brand-green outline-none transition-all resize-none leading-relaxed"
              />
              <p className="text-xs text-stone-400 leading-relaxed">AI가 입력된 내용만 바탕으로 항목별로 분류하여 작성합니다. 없는 사실은 만들지 않습니다.</p>
            </div>
          </section>

          {/* Step 3. 생성 버튼 */}
          <div className="bg-white rounded-3xl border border-stone-200 shadow-sm p-6 lg:p-8 space-y-3">
            <span className="text-xs font-bold text-brand-green uppercase tracking-widest block">Step 3. AI 교사회의록 생성</span>
            <button
              onClick={generateMinutes}
              disabled={processing || (!selectedFile && !meetingData.memo.trim())}
              className={`w-full py-5 rounded-2xl font-bold text-lg flex items-center justify-center gap-3 transition-all shadow-xl ${
                processing || (!selectedFile && !meetingData.memo.trim())
                  ? 'bg-stone-100 text-stone-300 cursor-not-allowed'
                  : 'bg-brand-green text-white hover:bg-brand-green-dark hover:scale-[1.02] active:scale-[0.98]'
              }`}
            >
              {processing ? <Loader2 className="w-6 h-6 animate-spin" /> : hasResult ? <RotateCcw className="w-6 h-6" /> : <Sparkles className="w-6 h-6" />}
              {hasResult ? '다시 생성' : 'AI 생성'}
            </button>
            <p className="text-xs text-stone-400 text-center leading-relaxed">생성 후 각 항목에서 내용을 직접 수정할 수 있습니다.</p>
          </div>
        </div>

        {/* Right: 미리보기 */}
        <div className="lg:col-span-3">
          <div className="bg-white rounded-3xl border border-stone-200 shadow-xl p-6 lg:p-10 space-y-6 lg:sticky lg:top-24">
            <div className="flex items-center justify-between gap-3 flex-wrap">
              <h2 className="font-bold text-lg text-stone-700">회의록 미리보기</h2>
              {hasResult && (
                <span className="px-3 py-1 bg-[#F0F4F3] border border-[#E6E8EE] rounded-full text-[#84A59D] text-[13px] font-medium flex items-center gap-1.5 shadow-sm">
                  <CheckCircle2 className="w-4 h-4" />
                  생성 완료 · 수정 가능
                </span>
              )}
            </div>

            <h3 className="text-center text-2xl lg:text-3xl font-bold tracking-widest underline underline-offset-[12px] decoration-brand-green/30">
              {meetingData.title || '교사회의록'}
            </h3>

            <div className="w-full border-t border-l border-black text-sm lg:text-base overflow-x-auto">
              <div className="min-w-[520px]">
                {/* 기본정보: 일시 / 장소 */}
                <div className="flex">
                  <div className="w-1/6 p-3 border-r border-b border-black bg-stone-50 font-bold flex items-center justify-center text-center">일 시</div>
                  <div className="w-2/6 p-3 border-r border-b border-black flex items-center justify-center text-center">{meetingData.date.replace('T', ' ')}</div>
                  <div className="w-1/6 p-3 border-r border-b border-black bg-stone-50 font-bold flex items-center justify-center text-center">장 소</div>
                  <div className="w-2/6 p-3 border-r border-b border-black flex items-center justify-center text-center">{meetingData.location}</div>
                </div>
                {/* 기본정보: 참석자 */}
                <div className="flex">
                  <div className="w-1/6 p-3 border-r border-b border-black bg-stone-50 font-bold flex items-center justify-center text-center">참석자</div>
                  <div className="w-5/6 p-3 border-r border-b border-black flex items-center justify-center text-center">{meetingData.attendees}</div>
                </div>

                {/* 본문 5개 항목 */}
                {processing ? (
                  <div className="border-r border-b border-black min-h-[400px] flex flex-col items-center justify-center gap-6 text-stone-400">
                    <Loader2 className="w-10 h-10 animate-spin text-brand-green" />
                    <p className="text-base font-medium">AI가 회의 내용을 분석하고 있습니다...</p>
                  </div>
                ) : (
                  SECTION_LABELS.map(({ key, label, hint }) => (
                    <div key={key} className="flex group relative">
                      <div className="w-1/6 p-3 border-r border-b border-black bg-stone-50 font-bold flex items-center justify-center text-center leading-snug">{label}</div>
                      <div className="w-5/6 p-4 border-r border-b border-black min-h-[72px] flex items-start text-left whitespace-pre-wrap leading-relaxed">
                        {editingSection === key ? (
                          <div className="w-full space-y-3">
                            <textarea
                              value={editDraft}
                              onChange={e => setEditDraft(e.target.value)}
                              rows={8}
                              autoFocus
                              className="w-full p-3 bg-stone-50 border border-stone-300 rounded-xl text-base focus:ring-2 focus:ring-brand-green outline-none leading-relaxed resize-y"
                            />
                            <div className="flex gap-2 justify-end">
                              <button
                                onClick={() => setEditingSection(null)}
                                className="px-4 py-2 rounded-xl border border-stone-200 text-stone-500 text-sm font-bold hover:bg-stone-50"
                              >
                                취소
                              </button>
                              <button onClick={saveEdit} className="px-4 py-2 rounded-xl bg-brand-green text-white text-sm font-bold hover:bg-brand-green-dark">
                                저장
                              </button>
                            </div>
                          </div>
                        ) : sections[key] ? (
                          stripMarkdown(sections[key])
                        ) : (
                          <span className="text-stone-300">{hasResult ? '내용 없음 — 직접 입력할 수 있습니다.' : hint}</span>
                        )}
                      </div>
                      {editingSection !== key && (
                        <button
                          onClick={() => startEdit(key)}
                          title={`${label} 수정`}
                          className="absolute right-3 top-3 p-2 rounded-full bg-stone-100 text-stone-400 hover:bg-brand-green hover:text-white opacity-0 group-hover:opacity-100 transition-all shadow-sm"
                        >
                          <Pencil className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  ))
                )}
              </div>
            </div>

            {!hasResult && !processing && (
              <p className="text-center text-sm text-stone-400 leading-relaxed">
                회의 메모를 입력하고 <span className="font-bold text-stone-600">AI 생성</span> 버튼을 누르면
                <br />
                5개 항목으로 구성된 교사회의록이 자동 작성됩니다.
              </p>
            )}

            <div className="pt-6 border-t border-stone-100 flex justify-between items-end">
              <div className="flex flex-col gap-1">
                <span className="text-xs text-stone-400 uppercase tracking-widest">Generated by</span>
                <span className="font-serif font-bold text-lg text-stone-800">교사회의록 작성도우미 AI</span>
              </div>
              <CheckCircle2 className="w-10 h-10 text-brand-green/20" />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
