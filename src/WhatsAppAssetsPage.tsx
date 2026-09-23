import { useState, useEffect, useCallback, useRef } from 'react';
import { supabase } from './supabaseClient';
import {
  FileText, Image as ImageIcon, Plus, Search, X, Loader2,
  AlertCircle, Trash2, Pencil, Upload, File as FileIcon,
} from 'lucide-react';
import { formatBytes } from './utils/formatBytes';

// ── Types ───────────────────────────────────────────────────────────────────

interface WhatsAppAsset {
  id: string;
  name: string;
  description: string | null;
  asset_type: 'DOCUMENT' | 'IMAGE';
  file_name: string;
  storage_path: string;
  mime_type: string;
  file_size: number | null;
  share_message: string | null;
  active: boolean;
  created_at: string;
  updated_at: string;
}

type AssetFilter = 'all' | 'DOCUMENT' | 'IMAGE';

// ── Constants ────────────────────────────────────────────────────────────────

const BUCKET = 'whatsapp-assets';
const MAX_FILE_SIZE = 25 * 1024 * 1024; // 25 MB

const ACCEPTED_MIME: Record<string, string[]> = {
  DOCUMENT: ['application/pdf'],
  IMAGE: ['image/jpeg', 'image/png', 'image/webp'],
};

const ACCEPTED_EXTENSIONS: Record<string, string[]> = {
  DOCUMENT: ['.pdf'],
  IMAGE: ['.jpg', '.jpeg', '.png', '.webp'],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

function validateFile(file: File, assetType: 'DOCUMENT' | 'IMAGE'): string | null {
  if (file.size > MAX_FILE_SIZE) {
    return `File is too large. Maximum size is ${formatBytes(MAX_FILE_SIZE)}.`;
  }
  const allowedMime = ACCEPTED_MIME[assetType];
  const allowedExt = ACCEPTED_EXTENSIONS[assetType];
  const ext = '.' + (file.name.split('.').pop() ?? '').toLowerCase();
  if (!allowedMime.includes(file.type) && !allowedExt.includes(ext)) {
    return `Unsupported file type for ${assetType}. Allowed: ${allowedExt.join(', ')}`;
  }
  return null;
}

function buildStoragePath(assetId: string, fileName: string): string {
  return `${assetId}/${fileName}`;
}

// ── Component ────────────────────────────────────────────────────────────────

export default function WhatsAppAssetsPage() {
  const [assets, setAssets] = useState<WhatsAppAsset[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [searchInput, setSearchInput] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [activeFilter, setActiveFilter] = useState<AssetFilter>('all');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingAsset, setEditingAsset] = useState<WhatsAppAsset | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<WhatsAppAsset | null>(null);
  const [thumbUrls, setThumbUrls] = useState<Record<string, string>>({});

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Fetch assets ──
  const fetchAssets = useCallback(async () => {
    setLoading(true);
    setError('');
    let q = supabase
      .from('whatsapp_assets')
      .select('*')
      .order('created_at', { ascending: false });

    if (activeFilter !== 'all') {
      q = q.eq('asset_type', activeFilter);
    }

    if (searchTerm.trim()) {
      const term = searchTerm.trim();
      q = q.or(`name.ilike.%${term}%,file_name.ilike.%${term}%`);
    }

    const { data, error: err } = await q;
    if (err) {
      setError(err.message || 'Failed to load assets.');
      setAssets([]);
    } else {
      setAssets((data ?? []) as WhatsAppAsset[]);
    }
    setLoading(false);
  }, [activeFilter, searchTerm]);

  useEffect(() => {
    fetchAssets();
  }, [fetchAssets]);

  // ── Generate signed URLs for image thumbnails ──
  useEffect(() => {
    const imageAssets = assets.filter(a => a.asset_type === 'IMAGE');
    if (imageAssets.length === 0) {
      setThumbUrls({});
      return;
    }
    let cancelled = false;
    (async () => {
      const urls: Record<string, string> = {};
      for (const asset of imageAssets) {
        const { data } = await supabase.storage
          .from(BUCKET)
          .createSignedUrl(asset.storage_path, 300);
        if (data && !cancelled) {
          urls[asset.id] = data.signedUrl;
        }
      }
      if (!cancelled) setThumbUrls(urls);
    })();
    return () => { cancelled = true; };
  }, [assets]);

  // ── Debounced search ──
  function handleSearchChange(v: string) {
    setSearchInput(v);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      setSearchTerm(v);
    }, 350);
  }

  function clearSearch() {
    setSearchInput('');
    setSearchTerm('');
  }

  function handleFilterChange(f: AssetFilter) {
    setActiveFilter(f);
  }

  function handleAdd() {
    setEditingAsset(null);
    setModalOpen(true);
  }

  function handleEdit(asset: WhatsAppAsset) {
    setEditingAsset(asset);
    setModalOpen(true);
  }

  async function handleDeleteConfirmed() {
    if (!deleteTarget) return;
    const target = deleteTarget;
    setDeleteTarget(null);

    // Delete storage object first, then DB row
    const { error: storageErr } = await supabase.storage
      .from(BUCKET)
      .remove([target.storage_path]);

    // If storage delete fails because the file doesn't exist, we still
    // proceed with the DB delete — the row is the source of truth.
    if (storageErr && !storageErr.message.includes('not found')) {
      setError(`Failed to delete file: ${storageErr.message}`);
      return;
    }

    const { error: dbErr } = await supabase
      .from('whatsapp_assets')
      .delete()
      .eq('id', target.id);

    if (dbErr) {
      setError(`Failed to delete asset: ${dbErr.message}`);
      return;
    }

    fetchAssets();
  }

  // ── Render ──
  const FILTER_TABS: { label: string; value: AssetFilter }[] = [
    { label: 'All', value: 'all' },
    { label: 'Documents', value: 'DOCUMENT' },
    { label: 'Images', value: 'IMAGE' },
  ];

  return (
    <div className="p-6 max-w-5xl mx-auto">
      {/* Header */}
      <div className="flex items-start justify-between mb-5 gap-4">
        <div>
          <h1 className="text-xl font-semibold text-stone-800">WhatsApp Assets</h1>
          <p className="text-xs text-stone-500 mt-0.5">
            {assets.length > 0
              ? `${assets.length} asset${assets.length !== 1 ? 's' : ''}`
              : 'Manage reusable business documents and images'}
          </p>
        </div>
        <button
          onClick={handleAdd}
          className="flex items-center gap-1.5 px-3.5 py-2 text-sm font-medium rounded-lg bg-stone-800 text-white hover:bg-stone-700 transition"
        >
          <Plus className="w-4 h-4" />
          Add Asset
        </button>
      </div>

      {/* Search bar */}
      <div className="mb-3 relative">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-stone-400" />
        <input
          type="text"
          value={searchInput}
          onChange={e => handleSearchChange(e.target.value)}
          placeholder="Search assets by name or file name…"
          className="w-full pl-9 pr-9 py-2.5 text-sm border border-stone-200 rounded-xl bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
        />
        {searchInput && (
          <button
            onClick={clearSearch}
            className="absolute right-3 top-1/2 -translate-y-1/2 text-stone-400 hover:text-stone-600 transition"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex items-center gap-1.5 mb-4">
        {FILTER_TABS.map(tab => {
          const active = activeFilter === tab.value;
          return (
            <button
              key={tab.value}
              onClick={() => handleFilterChange(tab.value)}
              className={`flex-shrink-0 px-3 py-1.5 text-xs font-medium rounded-lg border transition ${
                active
                  ? 'bg-stone-800 border-stone-800 text-white'
                  : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-50'
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* Error state */}
      {error && !loading && (
        <div className="mb-5 flex items-center gap-2 px-4 py-3 bg-red-50 border border-red-200 text-red-700 text-sm rounded-xl">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          {error}
        </div>
      )}

      {/* Loading state */}
      {loading && (
        <div className="flex items-center justify-center py-24">
          <Loader2 className="w-6 h-6 text-stone-400 animate-spin" />
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && assets.length === 0 && (
        <div className="flex flex-col items-center justify-center py-20 text-center">
          <div className="w-14 h-14 rounded-full bg-stone-100 flex items-center justify-center mb-4">
            <FileText className="w-6 h-6 text-stone-400" />
          </div>
          <h2 className="text-sm font-semibold text-stone-700 mb-1">
            {searchTerm || activeFilter !== 'all' ? 'No assets match' : 'No assets yet'}
          </h2>
          <p className="text-xs text-stone-400 max-w-xs">
            {searchTerm || activeFilter !== 'all'
              ? 'Try adjusting your search or filters.'
              : 'Add a price list, brochure, catalogue, or product image to get started.'}
          </p>
        </div>
      )}

      {/* Asset list */}
      {!loading && !error && assets.length > 0 && (
        <div className="flex flex-col gap-2">
          {assets.map(asset => (
            <div
              key={asset.id}
              className="bg-white border border-stone-200 rounded-xl px-4 py-3.5 hover:border-stone-300 hover:shadow-sm transition-all duration-150"
            >
              <div className="flex items-start gap-3">
                {/* Thumbnail / icon */}
                <div className="flex-shrink-0 w-10 h-10 rounded-lg bg-stone-50 border border-stone-100 flex items-center justify-center overflow-hidden">
                  {asset.asset_type === 'IMAGE' && thumbUrls[asset.id] ? (
                    <img
                      src={thumbUrls[asset.id]}
                      alt={asset.name}
                      className="w-full h-full object-cover"
                    />
                  ) : asset.asset_type === 'IMAGE' ? (
                    <ImageIcon className="w-5 h-5 text-stone-400" />
                  ) : (
                    <FileText className="w-5 h-5 text-stone-400" />
                  )}
                </div>

                {/* Info */}
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-semibold text-stone-800 truncate">
                      {asset.name}
                    </span>
                    <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium border ${
                      asset.active
                        ? 'bg-green-50 text-green-700 border-green-200'
                        : 'bg-stone-100 text-stone-500 border-stone-200'
                    }`}>
                      {asset.active ? 'Active' : 'Inactive'}
                    </span>
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-stone-50 text-stone-500 border border-stone-200">
                      {asset.asset_type === 'IMAGE' ? (
                        <ImageIcon className="w-3 h-3" />
                      ) : (
                        <FileText className="w-3 h-3" />
                      )}
                      {asset.asset_type}
                    </span>
                  </div>
                  <p className="text-xs text-stone-400 mt-1 truncate">
                    {asset.file_name}
                    {asset.file_size != null && ` · ${formatBytes(asset.file_size)}`}
                  </p>
                  {asset.description && (
                    <p className="text-xs text-stone-500 mt-1 line-clamp-2 leading-relaxed">
                      {asset.description}
                    </p>
                  )}
                  {asset.share_message && (
                    <p className="text-xs text-stone-400 mt-1 italic line-clamp-1">
                      "{asset.share_message}"
                    </p>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button
                    onClick={() => handleEdit(asset)}
                    className="p-2 rounded-lg text-stone-500 hover:bg-stone-100 hover:text-stone-700 transition"
                    aria-label="Edit asset"
                  >
                    <Pencil className="w-4 h-4" />
                  </button>
                  <button
                    onClick={() => setDeleteTarget(asset)}
                    className="p-2 rounded-lg text-stone-500 hover:bg-red-50 hover:text-red-600 transition"
                    aria-label="Delete asset"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add/Edit modal */}
      {modalOpen && (
        <AssetModal
          asset={editingAsset}
          onClose={() => setModalOpen(false)}
          onSaved={() => {
            setModalOpen(false);
            fetchAssets();
          }}
        />
      )}

      {/* Delete confirmation */}
      {deleteTarget && (
        <DeleteConfirmModal
          asset={deleteTarget}
          onCancel={() => setDeleteTarget(null)}
          onConfirm={handleDeleteConfirmed}
        />
      )}
    </div>
  );
}

// ── Asset Modal (Add / Edit) ─────────────────────────────────────────────────

interface AssetModalProps {
  asset: WhatsAppAsset | null;
  onClose: () => void;
  onSaved: () => void;
}

function AssetModal({ asset, onClose, onSaved }: AssetModalProps) {
  const isEdit = !!asset;
  const [name, setName] = useState(asset?.name ?? '');
  const [description, setDescription] = useState(asset?.description ?? '');
  const [assetType, setAssetType] = useState<'DOCUMENT' | 'IMAGE'>(asset?.asset_type ?? 'DOCUMENT');
  const [file, setFile] = useState<File | null>(null);
  const [shareMessage, setShareMessage] = useState(asset?.share_message ?? '');
  const [active, setActive] = useState(asset?.active ?? true);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState('');
  const [fileError, setFileError] = useState('');

  function handleFileChange(f: File | null) {
    setFileError('');
    if (!f) {
      setFile(null);
      return;
    }
    const err = validateFile(f, assetType);
    if (err) {
      setFileError(err);
      setFile(null);
      return;
    }
    setFile(f);
  }

  function handleTypeChange(t: 'DOCUMENT' | 'IMAGE') {
    setAssetType(t);
    if (file) {
      // Re-validate existing file selection against new type
      const err = validateFile(file, t);
      if (err) {
        setFileError(err);
        setFile(null);
      }
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError('');

    if (!name.trim()) {
      setFormError('Name is required.');
      return;
    }

    if (!isEdit && !file) {
      setFormError('Please select a file to upload.');
      return;
    }

    setSaving(true);

    try {
      if (isEdit && asset) {
        // Edit: only update metadata fields
        const { error: dbErr } = await supabase
          .from('whatsapp_assets')
          .update({
            name: name.trim(),
            description: description.trim() || null,
            share_message: shareMessage.trim() || null,
            active,
          })
          .eq('id', asset.id);

        if (dbErr) {
          setFormError(dbErr.message || 'Failed to update asset.');
          setSaving(false);
          return;
        }
      } else {
        // Add: generate UUID, upload file, then insert row
        const assetId = crypto.randomUUID();
        const fileName = file!.name;
        const storagePath = buildStoragePath(assetId, fileName);

        // Upload to Storage
        const { error: uploadErr } = await supabase.storage
          .from(BUCKET)
          .upload(storagePath, file!, {
            contentType: file!.type || undefined,
            upsert: false,
          });

        if (uploadErr) {
          setFormError(`Upload failed: ${uploadErr.message}`);
          setSaving(false);
          return;
        }

        // Insert metadata row
        const { error: dbErr } = await supabase
          .from('whatsapp_assets')
          .insert({
            id: assetId,
            name: name.trim(),
            description: description.trim() || null,
            asset_type: assetType,
            file_name: fileName,
            storage_path: storagePath,
            mime_type: file!.type || 'application/octet-stream',
            file_size: file!.size,
            share_message: shareMessage.trim() || null,
            active,
          });

        if (dbErr) {
          // Clean up orphaned storage file
          await supabase.storage.from(BUCKET).remove([storagePath]);
          setFormError(dbErr.message || 'Failed to save asset metadata.');
          setSaving(false);
          return;
        }
      }

      onSaved();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : 'An unexpected error occurred.');
      setSaving(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-stone-100">
          <h2 className="text-base font-semibold text-stone-800">
            {isEdit ? 'Edit Asset' : 'Add Asset'}
          </h2>
          <button
            onClick={onClose}
            className="p-1.5 rounded-lg text-stone-400 hover:bg-stone-100 hover:text-stone-600 transition"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="px-5 py-4 space-y-4">
          {/* Name */}
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">
              Name <span className="text-red-500">*</span>
            </label>
            <input
              type="text"
              value={name}
              onChange={e => setName(e.target.value)}
              placeholder="e.g. Q3 Price List"
              className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition"
            />
          </div>

          {/* Description */}
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">
              Description
            </label>
            <textarea
              value={description}
              onChange={e => setDescription(e.target.value)}
              placeholder="Optional notes about this asset"
              rows={2}
              className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition resize-none"
            />
          </div>

          {/* Asset type — only selectable on new assets */}
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">
              Asset Type <span className="text-red-500">*</span>
            </label>
            {isEdit ? (
              <div className="px-3 py-2 text-sm text-stone-500 bg-stone-50 border border-stone-200 rounded-lg">
                {assetType} (cannot be changed after creation)
              </div>
            ) : (
              <div className="flex gap-2">
                {(['DOCUMENT', 'IMAGE'] as const).map(t => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => handleTypeChange(t)}
                    className={`flex items-center gap-2 px-4 py-2 text-sm font-medium rounded-lg border transition ${
                      assetType === t
                        ? 'bg-stone-800 border-stone-800 text-white'
                        : 'border-stone-200 bg-white text-stone-600 hover:bg-stone-50'
                    }`}
                  >
                    {t === 'IMAGE' ? (
                      <ImageIcon className="w-4 h-4" />
                    ) : (
                      <FileText className="w-4 h-4" />
                    )}
                    {t === 'DOCUMENT' ? 'Document' : 'Image'}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* File upload — only on new assets */}
          {!isEdit && (
            <div>
              <label className="block text-sm font-medium text-stone-700 mb-1">
                File <span className="text-red-500">*</span>
              </label>
              <div className="relative">
                <input
                  type="file"
                  onChange={e => handleFileChange(e.target.files?.[0] ?? null)}
                  accept={
                    assetType === 'DOCUMENT'
                      ? ACCEPTED_EXTENSIONS[assetType].join(',')
                      : ACCEPTED_EXTENSIONS[assetType].join(',')
                  }
                  className="w-full text-sm text-stone-600 file:mr-3 file:py-2 file:px-4 file:rounded-lg file:border-0 file:text-sm file:font-medium file:bg-stone-100 file:text-stone-700 hover:file:bg-stone-200 file:cursor-pointer file:transition cursor-pointer"
                />
              </div>
              {fileError && (
                <p className="text-xs text-red-600 mt-1 flex items-center gap-1">
                  <AlertCircle className="w-3 h-3" />
                  {fileError}
                </p>
              )}
              {file && !fileError && (
                <p className="text-xs text-stone-500 mt-1 flex items-center gap-1">
                  <FileIcon className="w-3 h-3" />
                  {file.name} · {formatBytes(file.size)}
                </p>
              )}
              <p className="text-xs text-stone-400 mt-1">
                {assetType === 'DOCUMENT'
                  ? 'PDF files only. '
                  : 'JPG, PNG, or WebP. '}
                Max {formatBytes(MAX_FILE_SIZE)}.
              </p>
            </div>
          )}

          {/* Share message */}
          <div>
            <label className="block text-sm font-medium text-stone-700 mb-1">
              Share Message
            </label>
            <textarea
              value={shareMessage}
              onChange={e => setShareMessage(e.target.value)}
              placeholder="Optional message to accompany this asset when shared"
              rows={3}
              className="w-full px-3 py-2 text-sm border border-stone-200 rounded-lg bg-white text-stone-800 placeholder:text-stone-400 focus:outline-none focus:ring-2 focus:ring-amber-500 focus:border-transparent transition resize-none"
            />
            <p className="text-xs text-stone-400 mt-1">
              This message is independent of WhatsApp templates.
            </p>
          </div>

          {/* Active toggle */}
          <label className="flex items-center gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={active}
              onChange={e => setActive(e.target.checked)}
              className="w-4 h-4 rounded border-stone-300 text-amber-600 focus:ring-amber-500"
            />
            <span className="text-sm text-stone-700">Active</span>
          </label>

          {/* Error */}
          {formError && (
            <div className="flex items-center gap-2 px-3 py-2.5 bg-red-50 border border-red-200 text-red-700 text-sm rounded-lg">
              <AlertCircle className="w-4 h-4 flex-shrink-0" />
              {formError}
            </div>
          )}

          {/* Actions */}
          <div className="flex items-center justify-end gap-2 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-stone-800 text-white hover:bg-stone-700 transition disabled:opacity-50"
            >
              {saving ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : isEdit ? (
                <Pencil className="w-4 h-4" />
              ) : (
                <Upload className="w-4 h-4" />
              )}
              {isEdit ? 'Save Changes' : 'Upload Asset'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ── Delete Confirmation Modal ───────────────────────────────────────────────

interface DeleteConfirmProps {
  asset: WhatsAppAsset;
  onCancel: () => void;
  onConfirm: () => void;
}

function DeleteConfirmModal({ asset, onCancel, onConfirm }: DeleteConfirmProps) {
  const [deleting, setDeleting] = useState(false);

  async function handleConfirm() {
    setDeleting(true);
    await onConfirm();
    setDeleting(false);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/30" onClick={onCancel} />
      <div className="relative bg-white rounded-2xl shadow-xl w-full max-w-sm">
        <div className="px-5 py-4">
          <div className="flex items-center gap-3 mb-3">
            <div className="w-10 h-10 rounded-full bg-red-50 flex items-center justify-center flex-shrink-0">
              <Trash2 className="w-5 h-5 text-red-600" />
            </div>
            <div>
              <h2 className="text-base font-semibold text-stone-800">Delete Asset</h2>
              <p className="text-xs text-stone-500">This cannot be undone.</p>
            </div>
          </div>
          <p className="text-sm text-stone-600 mb-4">
            Are you sure you want to delete <span className="font-medium text-stone-800">"{asset.name}"</span>?
            The file and all metadata will be permanently removed.
          </p>
          <div className="flex items-center justify-end gap-2">
            <button
              onClick={onCancel}
              className="px-4 py-2 text-sm font-medium rounded-lg border border-stone-200 text-stone-600 hover:bg-stone-50 transition"
            >
              Cancel
            </button>
            <button
              onClick={handleConfirm}
              disabled={deleting}
              className="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition disabled:opacity-50"
            >
              {deleting ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <Trash2 className="w-4 h-4" />
              )}
              Delete
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
