import { useState, useEffect } from 'react';
import { IconStar } from '../icons';
import { postObjectionFeedback } from '../api';

const starsKey = 'prospector-objection-stars';

function loadStars() {
  try {
    return new Set(JSON.parse(localStorage.getItem(starsKey) || '[]'));
  } catch {
    return new Set();
  }
}
function saveStars(set) {
  try {
    localStorage.setItem(starsKey, JSON.stringify(Array.from(set)));
  } catch {
    // localStorage can throw in private-browsing/quota-exceeded cases — starring
    // is a nice-to-have, so silently skip persisting rather than break the UI.
  }
}

export default function ObjectionModal({ objection, feedback, onClose, onFeedbackPosted }) {
  const [stars, setStars] = useState(loadStars);
  const [openBoxes, setOpenBoxes] = useState(() => new Set());
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');

  useEffect(() => {
    saveStars(stars);
  }, [stars]);

  const toggleStar = (key) => {
    setStars((prev) => {
      const next = new Set(prev);
      next.has(key) ? next.delete(key) : next.add(key);
      return next;
    });
  };

  const toggleBox = (i) => {
    setOpenBoxes((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  // One delegated handler for everything inside the rendered rebuttal list:
  // opt-toggle/star-btn are React-owned elements (handled via state above),
  // but .branch-toggle sits inside box.html's raw markup, so it's toggled
  // imperatively via classList — same technique the source file used.
  const handleBodyClick = (e) => {
    const branchToggle = e.target.closest('.branch-toggle');
    if (branchToggle) {
      branchToggle.closest('.branch')?.classList.toggle('open');
      return;
    }
    const optToggle = e.target.closest('.opt-toggle');
    if (optToggle) {
      const wrapper = optToggle.closest('[data-box-index]');
      if (wrapper) toggleBox(Number(wrapper.dataset.boxIndex));
      return;
    }
    const starBtn = e.target.closest('.star-btn');
    if (starBtn) toggleStar(starBtn.dataset.key);
  };

  const entries = feedback.filter((f) => f.objection === objection.name);

  const submit = async () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    setPosting(true);
    setPostError('');
    try {
      const created = await postObjectionFeedback(objection.name, trimmed);
      onFeedbackPosted(created);
      setText('');
    } catch (err) {
      setPostError(err.message);
    } finally {
      setPosting(false);
    }
  };

  return (
    <div className="overlay" onClick={onClose}>
      <div className="dialog dialog-wide" onClick={(e) => e.stopPropagation()}>
        <div className="dialog-head">
          <h3>{objection.name}</h3>
          <button className="modal-close" onClick={onClose} aria-label="Close" type="button">×</button>
        </div>
        <div className="dialog-body" onClick={handleBodyClick}>
          {objection.boxes.map((box, i) => {
            const key = `${objection.name}||${box.title}||${i}`;
            const starred = stars.has(key);
            const starBtn = (
              <button className={`star-btn${starred ? ' starred' : ''}`} data-key={key} type="button" title="Star this option">
                <IconStar width={16} height={16} fill={starred ? 'currentColor' : 'none'} />
              </button>
            );
            if (box.collapsed) {
              const open = openBoxes.has(i);
              return (
                <div className={`rebuttal${open ? ' open' : ''}`} key={i} data-box-index={i}>
                  <div className="reb-head">
                    <button className="opt-toggle" type="button">
                      <span className="chev">▶</span><span>{box.title}</span>
                    </button>
                    {starBtn}
                  </div>
                  <div className="opt-body" dangerouslySetInnerHTML={{ __html: box.html }} />
                </div>
              );
            }
            return (
              <div className="rebuttal" key={i}>
                <div className="reb-head">
                  <div className="rebuttal-num">{box.title}</div>
                  {starBtn}
                </div>
                <div dangerouslySetInnerHTML={{ __html: box.html }} />
              </div>
            );
          })}

          <div className="fb-wrap">
            <button className={`fb-toggle${feedbackOpen ? ' open' : ''}`} onClick={() => setFeedbackOpen((o) => !o)} type="button">
              <span className="chev">▶</span> Team feedback
              <span className="fb-count-badge">{entries.length}</span>
            </button>
            {feedbackOpen && (
              <div className="fb-panel">
                {entries.length
                  ? entries.map((e) => (
                      <div className="fb-entry" key={e._id}>
                        <div className="fb-entry-meta">
                          <span className="who">{e.authorEmail}</span>
                          <span>{new Date(e.createdAt).toLocaleDateString()}</span>
                        </div>
                        <div className="fb-entry-text">{e.text}</div>
                      </div>
                    ))
                  : <div className="fb-empty">No feedback yet — be the first to leave a note for the team.</div>}
                <div className="fb-form">
                  <textarea
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    placeholder="Feedback on this objection's responses… (e.g. 'Response 2 lands better if you pause after the question')"
                  />
                  <div className="fb-actions">
                    <div className="fb-note">Shared with the whole Prospector team — everyone signed in sees it immediately.</div>
                    <button className="btn small" onClick={submit} disabled={posting || !text.trim()} type="button">
                      {posting ? 'Posting…' : 'Post feedback'}
                    </button>
                  </div>
                  {postError && <p className="error">{postError}</p>}
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
