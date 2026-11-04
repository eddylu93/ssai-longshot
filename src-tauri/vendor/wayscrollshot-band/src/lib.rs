pub mod types {
    pub struct StitchStats {
        pub frame_count: u32,
        pub total_height: u32,
        pub last_append: u32,
    }
}

pub mod stitch {
    pub mod band;

    #[derive(Debug)]
    pub enum StitchOutcome {
        FirstFrame,
        Appended { added: u32 },
        NoProgress,
        NoMatch,
    }
}
