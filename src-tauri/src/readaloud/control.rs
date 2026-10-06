use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
#[derive(Default)]
pub struct Control {
    pub token: AtomicU64,
    pub paused: AtomicBool,
}
impl Control {
    pub fn accepts(&self, token: u64) -> bool {
        self.token.load(Ordering::SeqCst) == token
    }
    pub fn reset(&self, token: u64) {
        self.token.store(token, Ordering::SeqCst);
        self.paused.store(false, Ordering::SeqCst);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generation_invalidates_old_audio_but_pause_preserves_snapshot() {
        let c = Control::default();
        c.reset(2);
        assert!(c.accepts(2));
        assert!(!c.accepts(1));
        c.paused.store(true, Ordering::SeqCst);
        assert!(c.accepts(2));
        c.reset(3);
        assert!(!c.accepts(2));
    }
}
