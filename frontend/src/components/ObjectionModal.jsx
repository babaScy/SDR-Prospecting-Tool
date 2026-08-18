import { useMemo, useState } from 'react';
import { IconStar, IconChevronUp, IconChevronDown } from '../icons';
import { postObjectionFeedback, starObjectionResponse, voteObjectionResponse } from '../api';

export default function ObjectionModal({ objection, feedback, responses, onClose, onFeedbackPosted, onResponseChanged }) {
  const [openBoxes, setOpenBoxes] = useState(() => new Set());
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [text, setText] = useState('');
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState('');
  const [busyTitle, setBusyTitle] = useState(null);
  const [actionError, setActionError] = useState('');

  const toggleBox = (i) => {
    setOpenBoxes((prev) => {
      const next = new Set(prev);
      next.has(i) ? next.delete(i) : next.add(i);
      return next;
    });
  };

  // .branch-toggle sits inside box.html's raw markup (dangerouslySetInnerHTML),
  // so it has no React handler attached — toggle it imperatively via classList,
  // same technique the source tool used. .opt-toggle is React-owned (state above).
  // Star/vote buttons are also React-owned but wired with direct onClick handlers
  // (see renderBox below) rather than delegation, since each now triggers an
  // async network call.
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
    }
  };

  const responseFor = (title) =>
    responses.find((r) => r.objection === objection.name && r.boxTitle === title) || { netScore: 0, myVote: 0, myStarred: false };

  const runAction = async (title, action) => {
    setBusyTitle(title);
    setActionError('');
    try {
      onResponseChanged(await action());
    } catch (err) {
      setActionError(err.message);
    } finally {
      setBusyTitle(null);
    }
  };

  const toggleStar = (title) => runAction(title, () => starObjectionResponse(objection.name, title));
  const castVote = (title, value) => runAction(title, () => voteObjectionResponse(objection.name, title, value));

  const ordered = useMemo(() => {
    const withMeta = objection.boxes.map((box, i) => ({ box, i, ...responseFor(box.title) }));
    const byScoreThenOrder = (a, b) => b.netScore - a.netScore || a.i - b.i;
    return {
      starred: withMeta.filter((m) => m.myStarred).sort(byScoreThenOrder),
      rest: withMeta.filter((m) => !m.myStarred).sort(byScoreThenOrder),
    };
  }, [objection, responses]);

  const renderBox = ({ box, i, netScore, myVote, myStarred }) => {
    const busy = busyTitle === box.title;
    const voteControls = (
      <div className="vote-controls">
        <button
          className={`vote-btn up${myVote === 1 ? ' active' : ''}`}
          onClick={() => castVote(box.title, 1)}
          disabled={busy}
          type="button"
          title="Upvote this response"
        >
          <IconChevronUp width={14} height={14} />
        </button>
        <span className="vote-score">{netScore}</span>
        <button
          className={`vote-btn down${myVote === -1 ? ' active' : ''}`}
          onClick={() => castVote(box.title, -1)}
          disabled={busy}
          type="button"
          title="Downvote this response"
        >
          <IconChevronDown width={14} height={14} />
        </button>
      </div>
    );
    const starBtn = (
      <button
        className={`star-btn${myStarred ? ' starred' : ''}`}
        onClick={() => toggleStar(box.title)}
        disabled={busy}
        type="button"
        title="Star this option"
      >
        <IconStar width={16} height={16} fill={myStarred ? 'currentColor' : 'none'} />
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
            <div className="reb-actions">{voteControls}{starBtn}</div>
          </div>
          <div className="opt-body" dangerouslySetInnerHTML={{ __html: box.html }} />
        </div>
      );
    }
    return (
      <div className="rebuttal" key={i}>
        <div className="reb-head">
          <div className="rebuttal-num">{box.title}</div>
          <div className="reb-actions">{voteControls}{starBtn}</div>
        </div>
        <div dangerouslySetInnerHTML={{ __html: box.html }} />
      </div>
    );
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
          {actionError && <p className="error">{actionError}</p>}

          {ordered.starred.length > 0 && (
            <>
              <div className="starred-section-label">⭐ Your starred picks</div>
              {ordered.starred.map(renderBox)}
            </>
          )}
          {ordered.rest.map(renderBox)}

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
