import LeadCard from './LeadCard';

// Read-only popup opened by clicking a row in ListTable — same overlay/dialog
// pattern as ObjectionModal, just wrapping LeadCard instead of deciding anything.
export default function LeadDetailModal({ lead, onClose }) {
  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        {/* LeadCard renders its own company-name heading below, so this
            header just carries the close button rather than repeating it. */}
        <div className="dialog-head">
          <h3>Company details</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close" type="button">×</button>
        </div>
        <div className="dialog-body">
          <LeadCard lead={lead} />
        </div>
      </div>
    </div>
  );
}
