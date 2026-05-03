import { useEffect, useState, useCallback, useRef } from 'react';
import { supabase } from './supabaseClient';
import {
  Plus, Image, CheckCircle2, Loader2,
  AlertCircle, Trash2, Save, X, Eye, FileText, ChevronLeft, Upload,
} from 'lucide-react';

function useIsMobile() {
  const [isMobile, setIsMobile] = useState(() => window.innerWidth < 768);
  useEffect(() => {
    const handler = () => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handler);
    return () => window.removeEventListener('resize', handler);
  }, []);
  return isMobile;
}

interface Template {
  id: string;
  name: string;
  description: string | null;
  message: string;
  include_image: boolean;
  image_url: string | null;
  status: string;
  created_at: string;
  updated_at: string;
}

interface FormState {
  name: string;
  description: string;
  message: string;
  include_image: boolean;
  image_url: string;
  status: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  description: '',
  message: '',
  include_image: false,
  image_url: '',
  status: 'ACTIVE',
};

function isActive(status: string) {
  return status === 'ACTIVE' || status === 'true';
}

function toDisplayStatus(status: string) {
  return isActive(status) ? 'ACTIVE' : 'INACTIVE';
}

function toStoredStatus(display: string) {
  return display;
}

function templateToForm(t: Template): FormState {
  return {
    name: t.name ?? '',
    description: t.description ?? '',
    message: t.message ?? '',
    include_image: t.include_image ?? false,
    image_url: t.image_url ?? '',
    status: toDisplayStatus(t.status),
  };
}

function formChanged(a: FormState, b: FormState) {
  return JSON.stringify(a) !== JSON.stringify(b);
}

function renderPreview(message: string) {
  return message.replace(/\{\{client_name\}\}/g, 'Sample Name');
}

interface ToastProps { message: string; type: 'success' | 'error'; onClose: () => void; }

function Toast({ message, type, onClose }: ToastProps) {
  useEffect(() => {
    const t = setTimeout(onClose, 3500);
    return () => clearTimeout(t);
  }, [onClose]);
  return (
    <div className={`fixed bottom-6 right-6 z-50 flex items-center gap-3 px-4 py-3 rounded-xl shadow-lg border text-sm font-medium transition-all
      ${type === 'success' ? 'bg-green-50 border-green-200 text-green-800' : 'bg-red-50 border-red-200 text-red-800'}`}>
      {type === 'success' ? <CheckCircle2 className="w-4 h-4 flex-shrink-0" /> : <AlertCircle className="w-4 h-4 flex-shrink-0" />}
      {message}
      <button onClick={onClose} className="ml-1 opacity-60 hover:opacity-100 transition"><X className="w-3.5 h-3.5" /></button>
    </div>
  );
}

interface ConfirmDialogProps { message: string; onConfirm: () => void; onCancel: () => void; }

function ConfirmDialog({ message, onConfirm, onCancel }: ConfirmDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-2xl border border-stone-200 shadow-xl p-6 max-w-sm w-full mx-4">
        <div className="flex items-start gap-3 mb-5">
          <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-stone-700 leading-relaxed">{message}</p>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 text-sm font-medium text-stone-600 hover:text-stone-800 border border-stone-200 rounded-lg hover:bg-stone-50 transition">
            Cancel
          </button>
          <button onClick={onConfirm} className="px-4 py-2 text-sm font-medium text-white bg-red-600 hover:bg-red-700 rounded-lg transition">
            Delete
          </button>
        </div>
      </div>
    </div>
  );
}

interface UnsavedDialogProps { onDiscard: () => void; onCancel: () => void; }

function UnsavedDialog({ onDiscard, onCancel }: UnsavedDialogProps) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm">
      <div className="bg-white rounded-2xl border border-stone-200 shadow-xl p-6 max-w-sm w-full mx-4">
        <div className="flex items-start gap-3 mb-5">
          <AlertCircle className="w-5 h-5 text-yellow-500 flex-shrink-0 mt-0.5" />
          <p className="text-sm text-stone-700 leading-relaxed">You have unsaved changes. Discard them and continue?</p>
        </div>
        <div className="flex justify-end gap-2">
          <button onClick={onCancel} className="px-4 py-2 text-sm font-medium text-stone-600 hover:text-stone-800 border border-stone-200 rounded-lg hover:bg-stone-50 transition">
            Keep editing
          </button>
          <button onClick={onDiscard} className="px-4 py-2 text-sm font-medium text-white bg-yellow-600 hover:bg-yellow-700 rounded-lg transition">
            Discard changes
          </button>
        </div>
      </div>
    </div>
  );
}

export default function TemplatesPage() {
  const isMobile = useIsMobile();
  const [mobileShowDetail, setMobileShowDetail] = useState(false);

  const [templates, setTemplates] = useState<Template[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [savedForm, setSavedForm] = useState<FormState>(EMPTY_FORM);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [isNew, setIsNew] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [errors, setErrors] = useState<Partial<Record<keyof FormState, string>>>({});
  const [toast, setToast] = useState<{ message: string; type: 'success' | 'error' } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [unsavedTarget, setUnsavedTarget] = useState<'new' | string | null>(null);
  const [uploadingImage, setUploadingImage] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const showToast = useCallback((message: string, type: 'success' | 'error') => {
    setToast({ message, type });
  }, []);

  async function fetchTemplates() {
    setLoadingList(true);
    const { data, error } = await supabase
      .from('message_templates')
      .select('id, name, description, message, include_image, image_url, status, created_at, updated_at')
      .order('created_at', { ascending: false });
    if (!error && data) setTemplates(data as Template[]);
    setLoadingList(false);
  }

  useEffect(() => { fetchTemplates(); }, []);

  function isDirty() {
    return formChanged(form, savedForm);
  }

  function loadTemplate(t: Template) {
    const f = templateToForm(t);
    setSelectedId(t.id);
    setForm(f);
    setSavedForm(f);
    setIsNew(false);
    setErrors({});
    setMobileShowDetail(true);
  }

  function startNew() {
    setSelectedId(null);
    setForm(EMPTY_FORM);
    setSavedForm(EMPTY_FORM);
    setIsNew(true);
    setErrors({});
    setMobileShowDetail(true);
  }

  function handleSelectTemplate(t: Template) {
    if (isDirty()) {
      setUnsavedTarget(t.id);
      return;
    }
    loadTemplate(t);
  }

  function handleNewTemplate() {
    if (isDirty()) {
      setUnsavedTarget('new');
      return;
    }
    startNew();
  }

  function handleUnsavedDiscard() {
    const target = unsavedTarget;
    setUnsavedTarget(null);
    if (target === 'new') {
      startNew();
    } else if (target) {
      const t = templates.find(x => x.id === target);
      if (t) loadTemplate(t);
    }
  }

  function patch(field: keyof FormState, value: string | boolean) {
    setForm(f => ({ ...f, [field]: value }));
    setErrors(e => ({ ...e, [field]: undefined }));
  }

  function validate() {
    const e: Partial<Record<keyof FormState, string>> = {};
    if (!form.name.trim()) e.name = 'Name is required';
    if (!form.message.trim()) e.message = 'Message is required';
    setErrors(e);
    return Object.keys(e).length === 0;
  }

  async function handleImageUpload(file: File) {
    setUploadingImage(true);
    const ext = file.name.split('.').pop();
    const path = `${crypto.randomUUID()}.${ext}`;
    const { error } = await supabase.storage.from('template-images').upload(path, file);
    if (error) {
      showToast('Failed to upload image.', 'error');
    } else {
      const { data: { publicUrl } } = supabase.storage.from('template-images').getPublicUrl(path);
      patch('image_url', publicUrl);
    }
    setUploadingImage(false);
  }

  async function handleSave() {
    if (!validate()) return;
    setSaving(true);
    const payload = {
      name: form.name.trim(),
      description: form.description.trim() || null,
      message: form.message.trim(),
      include_image: form.include_image,
      image_url: form.include_image ? (form.image_url.trim() || null) : null,
      status: toStoredStatus(form.status),
      updated_at: new Date().toISOString(),
    };

    if (isNew) {
      const { data, error } = await supabase
        .from('message_templates')
        .insert(payload)
        .select()
        .maybeSingle();
      if (error || !data) {
        showToast('Failed to create template.', 'error');
      } else {
        showToast('Template created.', 'success');
        await fetchTemplates();
        loadTemplate(data as Template);
      }
    } else {
      const { error } = await supabase
        .from('message_templates')
        .update(payload)
        .eq('id', selectedId!);
      if (error) {
        showToast('Failed to save template.', 'error');
      } else {
        showToast('Template saved.', 'success');
        const updated = { ...form };
        setSavedForm(updated);
        await fetchTemplates();
      }
    }
    setSaving(false);
  }

  async function handleDelete() {
    if (!selectedId) return;
    setDeleting(true);
    setConfirmDelete(false);
    const { error } = await supabase
      .from('message_templates')
      .delete()
      .eq('id', selectedId);
    if (error) {
      showToast('Failed to delete template.', 'error');
    } else {
      showToast('Template deleted.', 'success');
      setSelectedId(null);
      setForm(EMPTY_FORM);
      setSavedForm(EMPTY_FORM);
      setIsNew(false);
      setMobileShowDetail(false);
      await fetchTemplates();
    }
    setDeleting(false);
  }

  function handleCancel() {
    setForm(savedForm);
    setErrors({});
  }

  const hasEditor = isNew || selectedId !== null;
  const dirty = isDirty();

  return (
    <div className="flex h-[calc(100vh-57px)] overflow-hidden">
      {/* ── LEFT PANEL ── */}
      <aside className={`
        flex-col bg-white border-r border-stone-200
        ${isMobile
          ? mobileShowDetail ? 'hidden' : 'flex w-full'
          : 'flex w-72 flex-shrink-0'}
      `}>
        <div className="px-4 py-3 border-b border-stone-100 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <FileText className="w-4 h-4 text-stone-400" />
            <span className="text-sm font-semibold text-stone-700">Templates</span>
          </div>
          <button
            onClick={handleNewTemplate}
            className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium text-white bg-stone-800 hover:bg-stone-700 rounded-lg transition"
          >
            <Plus className="w-3.5 h-3.5" /> New
          </button>
        </div>

        <div className="flex-1 overflow-y-auto">
          {loadingList ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 text-stone-400 animate-spin" />
            </div>
          ) : templates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 px-4 text-center">
              <FileText className="w-8 h-8 text-stone-200 mb-2" />
              <p className="text-xs text-stone-400">No templates yet. Create one.</p>
            </div>
          ) : (
            <ul className="py-1">
              {templates.map(t => {
                const active = isActive(t.status);
                const isSelected = selectedId === t.id;
                return (
                  <li key={t.id}>
                    <button
                      onClick={() => handleSelectTemplate(t)}
                      className={`w-full text-left px-4 py-3 border-b border-stone-50 transition-colors
                        ${isSelected
                          ? 'bg-stone-100 border-l-2 border-l-stone-800'
                          : 'hover:bg-stone-50 border-l-2 border-l-transparent'}`}
                    >
                      <div className="flex items-center justify-between mb-1 gap-2">
                        <span className="text-sm font-medium text-stone-800 truncate leading-tight">{t.name}</span>
                        <div className="flex items-center gap-1 flex-shrink-0">
                          {t.include_image && (
                            <Image className="w-3 h-3 text-stone-400" />
                          )}
                          <span className={`inline-block px-1.5 py-0.5 rounded text-[10px] font-semibold
                            ${active ? 'bg-green-100 text-green-700' : 'bg-stone-100 text-stone-500'}`}>
                            {active ? 'ACTIVE' : 'INACTIVE'}
                          </span>
                        </div>
                      </div>
                      <p className="text-xs text-stone-400 truncate leading-snug">
                        {(t.message ?? '').slice(0, 60)}{(t.message ?? '').length > 60 ? '…' : ''}
                      </p>
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </aside>

      {/* ── RIGHT PANEL ── */}
      <div className={`
        bg-stone-50
        ${isMobile
          ? mobileShowDetail ? 'flex flex-col w-full overflow-y-auto' : 'hidden'
          : 'flex-1 overflow-y-auto'}
      `}>
        {/* Mobile sticky back header */}
        {isMobile && mobileShowDetail && (
          <div className="sticky top-0 z-10 flex items-center gap-3 bg-white border-b border-stone-200 px-4 py-3 flex-shrink-0">
            <button
              onClick={() => setMobileShowDetail(false)}
              className="flex items-center gap-1.5 text-sm font-medium text-stone-600 hover:text-stone-900 transition"
            >
              <ChevronLeft className="w-4 h-4" />
              Templates
            </button>
            <span className="text-sm font-semibold text-stone-800 truncate">
              {isNew ? 'New Template' : (form.name || '—')}
            </span>
          </div>
        )}

        {!hasEditor ? (
          <div className="flex flex-col items-center justify-center h-full text-center px-8">
            <FileText className="w-12 h-12 text-stone-200 mb-3" />
            <p className="text-sm font-medium text-stone-400 mb-1">No template selected</p>
            <p className="text-xs text-stone-300">Pick one from the list or create a new template.</p>
          </div>
        ) : (
          <div className="p-6 max-w-2xl mx-auto flex flex-col gap-5">

            {/* Header */}
            <div className="flex items-center justify-between">
              <h2 className="text-base font-semibold text-stone-800">
                {isNew ? 'New Template' : 'Edit Template'}
              </h2>
              {dirty && (
                <span className="text-xs font-medium text-yellow-600 bg-yellow-50 border border-yellow-200 px-2 py-0.5 rounded-full">
                  Unsaved changes
                </span>
              )}
            </div>

            {/* Form card */}
            <div className="bg-white rounded-xl border border-stone-200 divide-y divide-stone-100">

              {/* Name */}
              <div className="px-5 py-4">
                <label className="block text-xs font-medium text-stone-500 mb-1.5">
                  Name <span className="text-red-400">*</span>
                </label>
                <input
                  type="text"
                  value={form.name}
                  onChange={e => patch('name', e.target.value)}
                  placeholder="e.g. Welcome Message"
                  className={`w-full text-sm px-3 py-2 rounded-lg border bg-white outline-none transition
                    ${errors.name ? 'border-red-300 focus:border-red-400' : 'border-stone-200 focus:border-stone-400'}`}
                />
                {errors.name && <p className="text-xs text-red-500 mt-1">{errors.name}</p>}
              </div>

              {/* Description */}
              <div className="px-5 py-4">
                <label className="block text-xs font-medium text-stone-500 mb-1.5">Description</label>
                <input
                  type="text"
                  value={form.description}
                  onChange={e => patch('description', e.target.value)}
                  placeholder="Optional short description"
                  className="w-full text-sm px-3 py-2 rounded-lg border border-stone-200 focus:border-stone-400 bg-white outline-none transition"
                />
              </div>

              {/* Status */}
              <div className="px-5 py-4">
                <label className="block text-xs font-medium text-stone-500 mb-1.5">Status</label>
                <select
                  value={form.status}
                  onChange={e => patch('status', e.target.value)}
                  className="text-sm px-3 py-2 rounded-lg border border-stone-200 focus:border-stone-400 bg-white outline-none transition"
                >
                  <option value="ACTIVE">ACTIVE</option>
                  <option value="INACTIVE">INACTIVE</option>
                </select>
              </div>

              {/* Message */}
              <div className="px-5 py-4">
                <label className="block text-xs font-medium text-stone-500 mb-1.5">
                  Message <span className="text-red-400">*</span>
                </label>
                <textarea
                  value={form.message}
                  onChange={e => patch('message', e.target.value)}
                  placeholder="Hi {{client_name}}, ..."
                  rows={6}
                  className={`w-full text-sm px-3 py-2 rounded-lg border bg-white outline-none transition font-mono resize-y
                    ${errors.message ? 'border-red-300 focus:border-red-400' : 'border-stone-200 focus:border-stone-400'}`}
                />
                {errors.message && <p className="text-xs text-red-500 mt-1">{errors.message}</p>}
                <p className="text-xs text-stone-400 mt-1">Use <code className="bg-stone-100 px-1 rounded">{'{{client_name}}'}</code> as a placeholder.</p>
              </div>

              {/* Include Image toggle */}
              <div className="px-5 py-4 flex items-center justify-between gap-4">
                <div>
                  <p className="text-xs font-medium text-stone-700">Include Image</p>
                  <p className="text-xs text-stone-400 mt-0.5">Attach an image to this template</p>
                </div>
                <button
                  type="button"
                  onClick={() => patch('include_image', !form.include_image)}
                  className={`relative flex-shrink-0 w-10 h-5.5 rounded-full transition-colors
                    ${form.include_image ? 'bg-stone-800' : 'bg-stone-200'}`}
                  style={{ width: '40px', height: '22px' }}
                >
                  <span
                    className={`absolute top-0.5 left-0.5 w-4.5 h-4.5 rounded-full bg-white shadow transition-transform
                      ${form.include_image ? 'translate-x-[18px]' : 'translate-x-0'}`}
                    style={{ width: '18px', height: '18px' }}
                  />
                </button>
              </div>

              {/* Image Upload — conditional */}
              {form.include_image && (
                <div className="px-5 py-4">
                  <label className="block text-xs font-medium text-stone-500 mb-2">Image</label>

                  {form.image_url ? (
                    <div className="relative group w-fit">
                      <img
                        src={form.image_url}
                        alt="Template image"
                        className="h-32 w-auto rounded-lg border border-stone-200 object-cover"
                      />
                      <div className="absolute inset-0 rounded-lg bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center gap-2">
                        <button
                          type="button"
                          onClick={() => fileInputRef.current?.click()}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-white text-stone-800 rounded-lg hover:bg-stone-100 transition"
                        >
                          <Upload className="w-3 h-3" /> Replace
                        </button>
                        <button
                          type="button"
                          onClick={() => patch('image_url', '')}
                          className="flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium bg-white text-red-600 rounded-lg hover:bg-red-50 transition"
                        >
                          <X className="w-3 h-3" /> Remove
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => fileInputRef.current?.click()}
                      disabled={uploadingImage}
                      className="flex flex-col items-center justify-center w-full h-28 rounded-xl border-2 border-dashed border-stone-200 hover:border-stone-400 bg-stone-50 hover:bg-stone-100 transition disabled:opacity-50 cursor-pointer gap-2"
                    >
                      {uploadingImage
                        ? <Loader2 className="w-5 h-5 text-stone-400 animate-spin" />
                        : <><Image className="w-5 h-5 text-stone-300" /><span className="text-xs text-stone-400">Click to upload image</span><span className="text-[10px] text-stone-300">JPG, PNG, GIF, WebP — max 5 MB</span></>
                      }
                    </button>
                  )}

                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/jpeg,image/jpg,image/png,image/gif,image/webp"
                    className="hidden"
                    onChange={e => {
                      const file = e.target.files?.[0];
                      if (file) handleImageUpload(file);
                      e.target.value = '';
                    }}
                  />
                </div>
              )}
            </div>

            {/* Live Preview */}
            {form.message.trim() && (
              <div className="bg-white rounded-xl border border-stone-200">
                <div className="px-5 py-3 border-b border-stone-100 flex items-center gap-2">
                  <Eye className="w-3.5 h-3.5 text-stone-400" />
                  <span className="text-xs font-semibold text-stone-500 uppercase tracking-wide">Live Preview</span>
                </div>
                <div className="px-5 py-4">
                  <div className="bg-stone-50 rounded-lg px-4 py-3 text-sm text-stone-700 whitespace-pre-wrap leading-relaxed border border-stone-100">
                    {renderPreview(form.message)}
                  </div>
                </div>
              </div>
            )}

            {/* Actions */}
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <button
                  onClick={handleSave}
                  disabled={saving}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-white bg-stone-800 hover:bg-stone-700 rounded-lg transition disabled:opacity-50"
                >
                  {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                  {saving ? 'Saving…' : 'Save'}
                </button>
                {dirty && (
                  <button
                    onClick={handleCancel}
                    className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-stone-600 border border-stone-200 hover:bg-stone-100 rounded-lg transition"
                  >
                    <X className="w-3.5 h-3.5" /> Cancel
                  </button>
                )}
              </div>
              {!isNew && (
                <button
                  onClick={() => setConfirmDelete(true)}
                  disabled={deleting}
                  className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium text-red-600 border border-red-200 hover:bg-red-50 rounded-lg transition disabled:opacity-50"
                >
                  {deleting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Trash2 className="w-3.5 h-3.5" />}
                  Delete
                </button>
              )}
            </div>

          </div>
        )}
      </div>

      {/* Dialogs & toasts */}
      {confirmDelete && (
        <ConfirmDialog
          message={`Delete "${form.name}"? This cannot be undone.`}
          onConfirm={handleDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
      {unsavedTarget !== null && (
        <UnsavedDialog
          onDiscard={handleUnsavedDiscard}
          onCancel={() => setUnsavedTarget(null)}
        />
      )}
      {toast && (
        <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />
      )}
    </div>
  );
}
