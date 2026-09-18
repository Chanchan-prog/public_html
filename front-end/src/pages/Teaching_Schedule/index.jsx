import React from 'react';
import Modal from '../../components/Modal.jsx';
import { apiGet } from '../../services/api.js';
import { AuthContext } from '../../context/AuthContext.jsx';
import useAutoRefresh, { AUTO_REFRESH_INTERVALS } from '../../utils/useAutoRefresh.js';

export default function MyAttendance(){
  const { user } = React.useContext(AuthContext);
  const [schedules, setSchedules] = React.useState([]);
  const [loading, setLoading] = React.useState(true);
  const [showModal, setShowModal] = React.useState(false);
  const [selected, setSelected] = React.useState(null);
  
  // NEW: State for Live Clock & Countdown
  const [currentTime, setCurrentTime] = React.useState(new Date());
  const [countdownStr, setCountdownStr] = React.useState('--:--:--');
  const [nextSubject, setNextSubject] = React.useState(null);

  const fetch = async ({ silent = false } = {})=>{
    if (!silent) setLoading(true);
    try{
      const data = await apiGet('my-schedule');
      setSchedules(Array.isArray(data)? data : []);
    }catch(e){ console.error(e); }
    if (!silent) setLoading(false);
  };

  React.useEffect(()=>{ fetch(); }, []);

  useAutoRefresh({
    refresh: () => fetch({ silent: true }),
    intervalMs: AUTO_REFRESH_INTERVALS.WORKFLOW,
    enabled: Boolean(user) && !showModal,
  });

  // LOGIC: Find the nearest upcoming schedule
  const getNextSchedule = (currentDate, scheduleList) => {
    if (!scheduleList || scheduleList.length === 0) return null;

    const daysMap = { sunday: 0, monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5, saturday: 6 };
    let closestDiff = Infinity;
    let upcomingClass = null;

    scheduleList.forEach(sched => {
      if(!sched.day_of_week || !sched.start_time) return;
      
      const schedDayIndex = daysMap[sched.day_of_week.toLowerCase()];
      const currentDayIndex = currentDate.getDay();
      
      // Calculate date of this schedule relative to today
      let targetDate = new Date(currentDate);
      let dayDiff = schedDayIndex - currentDayIndex;
      
      // If day is earlier in week, move to next week
      if (dayDiff < 0) {
        dayDiff += 7;
      }
      
      targetDate.setDate(currentDate.getDate() + dayDiff);
      
      // Set time
      const [h, m] = sched.start_time.split(':');
      targetDate.setHours(parseInt(h), parseInt(m), 0, 0);

      // If the time has already passed today, move to next week
      if (targetDate <= currentDate) {
        targetDate.setDate(targetDate.getDate() + 7);
      }

      const diff = targetDate - currentDate;
      
      if (diff < closestDiff) {
        closestDiff = diff;
        upcomingClass = { ...sched, targetDate, diff };
      }
    });

    return upcomingClass;
  };

  // NEW: Effect for Live Clock ticking AND Countdown
  React.useEffect(() => {
    const timer = setInterval(() => {
      const now = new Date();
      setCurrentTime(now);

      // Calculate Countdown
      if (schedules.length > 0) {
        const next = getNextSchedule(now, schedules);
        
        if (next) {
          setNextSubject(next);
          const diff = next.diff;
          
          // Format duration
          const days = Math.floor(diff / (1000 * 60 * 60 * 24));
          const hours = Math.floor((diff / (1000 * 60 * 60)) % 24);
          const minutes = Math.floor((diff / (1000 * 60)) % 60);
          const seconds = Math.floor((diff / 1000) % 60);

          // Pad with zeros
          const h = hours < 10 ? `0${hours}` : hours;
          const m = minutes < 10 ? `0${minutes}` : minutes;
          const s = seconds < 10 ? `0${seconds}` : seconds;

          if (days > 0) {
            setCountdownStr(`${days}d ${h}:${m}:${s}`);
          } else {
            setCountdownStr(`${h}:${m}:${s}`);
          }
        } else {
            setNextSubject(null);
            setCountdownStr('--:--:--');
        }
      }
    }, 1000);
    return () => clearInterval(timer);
  }, [schedules]);

  const openView = (row)=>{ setSelected(row); setShowModal(true); };
  const closeView = ()=>{ setSelected(null); setShowModal(false); };

  // Helper to format time (08:00:00 -> 8:00 AM)
  const formatTime = (t) => {
    if(!t) return '';
    const [h, m] = t.split(':');
    const hour = parseInt(h,10);
    const suffix = hour >= 12 ? 'PM' : 'AM';
    const fmtHour = hour % 12 || 12;
    return `${fmtHour}:${m} ${suffix}`;
  };

  // Days to display
  const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

  return (
    <div className="p-4 md:p-8 bg-gray-50 min-h-screen font-sans selection:bg-green-100">
      {/* INLINE STYLES FOR ANIMATION */}
      <style>{`
        @keyframes fadeInUp {
          from { opacity: 0; transform: translateY(20px); }
          to { opacity: 1; transform: translateY(0); }
        }
        .animate-fade-in-up {
          animation: fadeInUp 0.5s ease-out forwards;
        }
        .delay-100 { animation-delay: 100ms; }
        .delay-200 { animation-delay: 200ms; }
        .delay-300 { animation-delay: 300ms; }
        .schedule-day-list.is-scrollable {
          max-height: 24rem;
          overflow-y: auto;
          overscroll-behavior: contain;
          scrollbar-gutter: stable;
          scrollbar-width: thin;
          scrollbar-color: #94a3b8 #e2e8f0;
        }
        .schedule-day-list.is-scrollable::-webkit-scrollbar {
          width: 8px;
        }
        .schedule-day-list.is-scrollable::-webkit-scrollbar-track {
          background: #e2e8f0;
          border-radius: 999px;
        }
        .schedule-day-list.is-scrollable::-webkit-scrollbar-thumb {
          background: #94a3b8;
          border-radius: 999px;
          border: 2px solid #e2e8f0;
        }
        .schedule-day-list.is-scrollable::-webkit-scrollbar-thumb:hover {
          background: #64748b;
        }
      `}</style>

      {/* HEADER SECTION */}
      <div className="relative mb-10 rounded-2xl overflow-hidden shadow-xl text-white bg-[#1D8551]">
        {/* Decorative Background Elements */}
        <div className="absolute top-0 right-0 w-64 h-64 bg-white opacity-5 rounded-full -translate-y-1/2 translate-x-1/4 blur-3xl"></div>
        <div className="absolute bottom-0 left-0 w-40 h-40 bg-white opacity-10 rounded-full translate-y-1/3 -translate-x-1/4 blur-2xl"></div>

        <div className="relative z-10 p-6 md:p-8 flex flex-col xl:flex-row justify-between items-start xl:items-center gap-6">
          <div className="space-y-2 flex-1">
            <div className="flex items-center gap-2 text-white/90 text-sm font-medium tracking-wide uppercase">
              Faculty Portal
            </div>
            <h2 className="text-3xl md:text-4xl font-extrabold tracking-tight text-white">My Weekly Schedule</h2>
            <p className="text-white/90 text-sm md:text-base max-w-md">
              View your teaching load, assigned rooms, and class timings.
            </p>
          </div>

          <div className="flex flex-col md:flex-row gap-4 w-full xl:w-auto">
            
            {/* NEW: COUNTDOWN WIDGET */}
            <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-4 min-w-[180px] text-center shadow-lg transform transition-transform hover:scale-105 duration-300 text-white flex flex-col justify-center">
                <div className="text-xs text-emerald-200 uppercase tracking-widest font-semibold mb-1 truncate max-w-[160px] mx-auto">
                    {nextSubject ? 'Next: ' + nextSubject.subject_code : 'Next Schedule'}
                </div>
                <div className="text-3xl font-bold font-mono tracking-tighter leading-none text-white tabular-nums">
                    {countdownStr}
                </div>
                <div className="text-xs text-white/80 mt-1 truncate max-w-[160px] mx-auto">
                    {nextSubject ? nextSubject.subject_name : 'No classes found'}
                </div>
            </div>

            {/* LIVE CLOCK WIDGET */}
            <div className="bg-white/10 backdrop-blur-md border border-white/20 rounded-xl p-4 min-w-[180px] text-center shadow-lg transform transition-transform hover:scale-105 duration-300 text-white">
                <div className="text-xs text-white/80 uppercase tracking-widest font-semibold mb-1">
                {currentTime.toLocaleDateString('en-US', { weekday: 'long' })}
                </div>
                <div className="text-3xl font-bold font-mono tracking-tighter leading-none text-white tabular-nums">
                {currentTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).split(' ')[0]}
                <span className="text-base ml-1 align-top text-white/80">
                    {currentTime.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }).split(' ')[1]}
                </span>
                </div>
                <div className="text-xs text-white/80 mt-1">
                {currentTime.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
                </div>
            </div>

          </div>
        </div>
      </div>

      {loading ? (
        <div className="flex flex-col items-center justify-center py-20">
          <div className="w-12 h-12 border-4 border-emerald-200 border-t-emerald-600 rounded-full animate-spin"></div>
          <p className="mt-4 text-emerald-800 font-medium animate-pulse">Syncing schedule...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-7 gap-4 md:gap-6 items-start">
          {days.map((day, dayIndex) => {
            // Filter schedules for this specific day
            const daySchedules = schedules.filter(s => (s.day_of_week || '').toLowerCase() === day);

            // Stagger animation based on index
            const animationDelay = `delay-${(dayIndex * 100) % 500}`; 

            return (
              <div 
                key={day} 
                className={`flex flex-col bg-white rounded-xl shadow-sm hover:shadow-xl transition-all duration-300 border border-gray-100 overflow-hidden h-full animate-fade-in-up`}
                style={{ animationDelay: `${dayIndex * 100}ms` }}
              >
                {/* Day Header */}
                <div className={`flex items-center justify-center gap-2 p-3 text-center font-bold uppercase tracking-wider text-sm border-b
                  ${day.toLowerCase() === currentTime.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase() 
                    ? 'bg-[#1D8551] text-white' 
                    : 'bg-gray-100 text-gray-600'}`}>
                  <span>{day}</span>
                  {daySchedules.length > 0 ? (
                    <span className={`rounded-full px-2 py-0.5 text-[10px] leading-none ${
                      day.toLowerCase() === currentTime.toLocaleDateString('en-US', { weekday: 'long' }).toLowerCase()
                        ? 'bg-white/20 text-white'
                        : 'bg-white text-slate-500 shadow-sm'
                    }`}>
                      {daySchedules.length}
                    </span>
                  ) : null}
                </div>
                
                {/* Schedule Cards Container */}
                <div
                  className={`schedule-day-list p-3 flex-1 space-y-3 bg-gray-50/30 min-h-[150px] ${daySchedules.length > 3 ? 'is-scrollable' : ''}`}
                  aria-label={`${day} schedules${daySchedules.length > 3 ? ', scroll for more' : ''}`}
                >
                  {daySchedules.length > 0 ? (
                    daySchedules.map((sched, idx) => (
                      <div 
                        key={idx} 
                        onClick={() => openView(sched)}
                        className="group bg-white p-3 rounded-lg border border-gray-100 relative overflow-hidden cursor-pointer 
                                   hover:border-emerald-400 hover:shadow-md transition-all duration-300 transform hover:-translate-y-1"
                      >
                        {/* Left Color Bar */}
                        <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-[#1D8551] to-emerald-600 group-hover:w-1.5 transition-all"></div>

                        <div className="flex justify-between items-start mb-2 pl-2">
                            <span className="text-[10px] font-bold text-emerald-700 bg-emerald-50 border border-emerald-100 px-2 py-0.5 rounded-full">
                                {formatTime(sched.start_time)} - {formatTime(sched.end_time)}
                            </span>
                        </div>
                        
                        <div className="pl-2">
                            <h4 className="font-bold text-gray-800 text-sm leading-tight mb-0.5 group-hover:text-emerald-700 transition-colors">
                                {sched.subject_code}
                            </h4>
                            <div className="text-xs text-gray-500 line-clamp-1" title={sched.subject_name}>
                                {sched.subject_name}
                            </div>
                        </div>
                        
                        <div className="mt-3 pt-2 border-t border-gray-50 flex justify-between items-center text-xs text-gray-500 pl-2">
                            <div className="flex items-center gap-1.5">
                                <svg className="w-3.5 h-3.5 text-gray-400 group-hover:text-emerald-500 transition-colors" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17.657 16.657L13.414 20.9a1.998 1.998 0 01-2.827 0l-4.244-4.243a8 8 0 1111.314 0z"></path><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 11a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                                <span className="font-medium">{sched.room_name || sched.room_id}</span>
                            </div>
                            <span className="bg-gray-100 px-2 py-0.5 rounded text-gray-600 font-medium text-[10px]">
                                {sched.section_name}
                            </span>
                        </div>
                      </div>
                    ))
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center text-gray-300 py-10 gap-2">
                      <div className="w-8 h-8 rounded-full bg-gray-100 flex items-center justify-center">
                        <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M20 12H4"></path></svg>
                      </div>
                      <span className="text-xs italic">Rest Day</span>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Detail Modal */}
      <Modal show={showModal} title="Class Details" onClose={closeView} size="md">
        {selected ? (
          <div className="space-y-6 p-4">
            <div className="text-center pb-6 border-b border-gray-100 relative">
                <div className="w-16 h-1 bg-emerald-500 rounded-full mx-auto mb-4"></div>
                <div className="text-3xl font-extrabold text-gray-800 tracking-tight">{selected.subject_code}</div>
                <div className="text-emerald-600 font-medium text-sm mt-1">{selected.subject_name}</div>
            </div>

            <div className="grid grid-cols-2 gap-4">
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 hover:border-emerald-200 transition-colors">
                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Time Schedule</div>
                    <div className="font-bold text-gray-800 text-lg flex items-center gap-2">
                       <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z"></path></svg>
                       {formatTime(selected.start_time)}
                    </div>
                    <div className="text-xs text-gray-500 mt-1">To {formatTime(selected.end_time)}</div>
                </div>
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 hover:border-emerald-200 transition-colors">
                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Day of Week</div>
                    <div className="font-bold text-gray-800 text-lg capitalize flex items-center gap-2">
                      <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z"></path></svg>
                      {selected.day_of_week}
                    </div>
                </div>
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 hover:border-emerald-200 transition-colors">
                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Assigned Room</div>
                    <div className="font-bold text-gray-800 text-lg flex items-center gap-2">
                      <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a1 1 0 011-1h2a1 1 0 011 1v5m-4 0h4"></path></svg>
                      {selected.room_name}
                    </div>
                </div>
                <div className="bg-gray-50 p-4 rounded-xl border border-gray-100 hover:border-emerald-200 transition-colors">
                    <div className="text-[10px] font-bold text-gray-400 uppercase tracking-wider mb-1">Section Code</div>
                    <div className="font-bold text-gray-800 text-lg flex items-center gap-2">
                       <svg className="w-4 h-4 text-emerald-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z"></path></svg>
                       {selected.section_name}
                    </div>
                </div>
            </div>
            
            <div className="flex justify-end pt-4">
                <button onClick={closeView} className="px-6 py-2.5 bg-gray-800 hover:bg-gray-900 text-white rounded-lg text-sm font-bold shadow-lg shadow-gray-200 transition-all transform hover:-translate-y-0.5">
                    Close Details
                </button>
            </div>
          </div>
        ) : null}
      </Modal>

    </div>
  );
}
