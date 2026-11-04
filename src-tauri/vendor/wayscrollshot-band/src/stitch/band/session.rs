use super::compare::{overlap_diff, Window};
use super::fixed::FixedRegions;
use super::pixels::{Image, ImageError};
use super::long_image::LongImage;
use super::motion::MotionMask;
use super::profile::Signature;
use super::types::{Config, Edge, Stats, Status, StitchResult};

pub struct Stitcher {
    pub(crate) config: Config,
    pub(crate) long: LongImage,
    pub(crate) last_frame: Option<Image>,
    pub(crate) last_cols: Signature,
    pub(crate) fixed: FixedRegions,
    pub(crate) motion: MotionMask,
    pub(crate) last_offset: i32,
    pub(crate) best_bottom_trim: i32,
    pub(crate) best_top_trim: i32,
    pub(crate) pending_edge: Edge,
    pub(crate) growth_edge: Edge,
    pub(crate) anchor: i32,
    pub(crate) stats: Stats,
    pub(crate) recovering: bool,
}

impl Stitcher {
    pub(crate) fn placement_matches(&self, frame: &Image, position: i32, top: i32, bottom: i32) -> bool {
        self.pixel_matches(frame, position, top, bottom)
            && (!(self.recovering || position == self.anchor)
                || self.recovery_pixels_match(frame, position, top, bottom))
    }

    // After a gap, average similarity cannot prove that a repeated image is the same occurrence.
    fn recovery_pixels_match(&self, frame: &Image, position: i32, top: i32, bottom: i32) -> bool {
        let start = top.max(position + self.fixed.top()).max(0);
        let end = (self.long.height() - bottom).min(position + frame.height() - self.fixed.bottom());
        if end - start < self.config.min_overlap { return false; }
        let (mut left, mut right, mut first, mut last) = (i32::MAX, 0, i32::MAX, 0);
        for band in 0..super::profile::BAND_COUNT {
            if self.motion.weights[band] <= 0.0 { continue; }
            let (x0, x1) = super::profile::band_columns(frame.width(), band);
            for y in start..end {
                for x in x0..=x1 {
                    let a = self.long.row(y)[x as usize];
                    let b = frame.row(y - position)[x as usize];
                    if [16, 8, 0].iter().any(|shift| ((a >> shift) & 255).abs_diff((b >> shift) & 255) > 3) {
                        left = left.min(x); right = right.max(x);
                        first = first.min(y); last = last.max(y);
                        if right - left >= 24 || last - first >= 24 { return false; }
                    }
                }
            }
        }
        true
    }

    pub(crate) fn ambiguous_growth(&self, frame: &Image, cols: &Signature, position: i32, trim: (i32, i32)) -> bool {
        let score = self.known_diff(cols, position, trim).0.min(self.config.accept_diff);
        let maximum = (frame.height() - self.config.min_overlap).max(0);
        for candidate in self.anchor - maximum..=self.anchor + maximum {
            if (candidate - position).abs() <= 3 { continue; }
            let (difference, overlap) = self.known_diff(cols, candidate, trim);
            if overlap >= self.config.min_overlap && difference <= score + 0.15
                && self.pixel_matches(frame, candidate, trim.0, trim.1)
                && self.recovery_pixels_match(frame, candidate, trim.0, trim.1) { return true; }
        }
        false
    }

    // Local guard: signatures propose a position; original RGB pixels must confirm it.
    // One outlier band is tolerated for pointers/animations, never a whole bad frame.
    pub(crate) fn pixel_matches(&self, frame: &Image, position: i32, trim_top: i32, trim_bottom: i32) -> bool {
        let start = trim_top.max(position + self.fixed.top()).max(0);
        let end = (self.long.height() - trim_bottom).min(position + frame.height() - self.fixed.bottom());
        if end - start < self.config.min_overlap { return false; }
        let mut active = 0;
        let mut good = 0;
        for band in 0..super::profile::BAND_COUNT {
            if self.motion.weights[band] <= 0.0 { continue; }
            let (left, right) = super::profile::band_columns(frame.width(), band);
            let mut count = 0_u64;
            let mut difference = 0_u64;
            let mut changed = 0_u64;
            let previous = self.last_frame.as_ref().filter(|last| last.height() == frame.height());
            for y in start..end {
                let old = self.long.row(y);
                let new = frame.row(y - position);
                for x in left..=right {
                    let a = old[x as usize];
                    let b = new[x as usize];
                    let mut maximum = 0;
                    for shift in [16, 8, 0] {
                        let delta = ((a >> shift) & 255).abs_diff((b >> shift) & 255);
                        difference += u64::from(delta);
                        maximum = maximum.max(delta);
                    }
                    changed += u64::from(maximum > 24);
                    count += 1;
                }
            }
            let matches = count > 0 && difference <= count * 3 * 5 && changed * 100 <= count * 5;
            // Inspect the whole viewport so a highlight near the overlap boundary cannot dominate this test.
            if !matches && position != self.anchor {
                if let Some(last) = previous {
                    let mut stationary_changed = 0_u64;
                    let total = u64::from(frame.height() as u32) * (right - left + 1) as u64;
                    for y in 0..frame.height() {
                        for x in left..=right {
                            let a = last.row(y)[x as usize];
                            let b = frame.row(y)[x as usize];
                            if [16, 8, 0].iter().any(|shift| ((a >> shift) & 255).abs_diff((b >> shift) & 255) > 24) {
                                stationary_changed += 1;
                            }
                        }
                    }
                    if stationary_changed * 100 <= total * 15 { continue; }
                }
            }
            active += 1;
            if matches { good += 1; }
        }
        active >= 2 && good >= active - usize::from(active >= 4)
    }

    /// 用 config 创建独立拼接会话，返回会话或非法配置错误。
    pub fn new(config: Config) -> Result<Self, ImageError> {
        if !config.valid() {
            return Err(ImageError::Parameter);
        }
        Ok(Self {
            config,
            long: LongImage::default(),
            last_frame: None,
            last_cols: Vec::new(),
            fixed: FixedRegions::default(),
            motion: MotionMask::default(),
            last_offset: 0,
            best_bottom_trim: 0,
            best_top_trim: 0,
            pending_edge: Edge::None,
            growth_edge: Edge::None,
            anchor: 0,
            stats: Stats::default(),
            recovering: false,
        })
    }

    /// 返回会话当前统计；无参数。
    pub fn stats(&self) -> Stats {
        self.stats
    }

    /// 返回最终图像；无参数，未初始化返回 None，失败返回内存错误。
    pub fn full_image(&self) -> Result<Option<Image>, ImageError> {
        if self.long.height() == 0 {
            return Ok(None);
        }
        Ok(Some(self.long.image()?))
    }

    /// 用 frame、cols 设置第一帧，返回种子帧结果或内存错误。
    pub(crate) fn initialize(
        &mut self,
        frame: Image,
        cols: Signature,
    ) -> Result<StitchResult, ImageError> {
        self.long.reset(&frame, cols.clone())?;
        self.fixed.reset();
        self.motion = MotionMask::default();
        self.anchor = 0;
        self.best_bottom_trim = 0;
        self.best_top_trim = 0;
        self.pending_edge = Edge::None;
        self.growth_edge = Edge::None;
        let height = frame.height();
        self.stats = Stats {
            frame_count: 1,
            total_height: height,
            last_append: height,
        };
        self.recovering = false;
        self.remember(frame, cols);
        Ok(StitchResult {
            status: Status::FirstFrame,
            added: height,
            edge: Edge::None,
            position: 0,
            frame_length: height,
        })
    }

    /// 保存 frame、cols 作为下一帧匹配基准；无返回值。
    pub(crate) fn remember(&mut self, frame: Image, cols: Signature) {
        self.last_frame = Some(frame);
        self.last_cols = cols;
    }

    /// 根据当前固定带与配置构造比较窗口；无参数，返回窗口。
    pub(crate) fn window(&self) -> Window {
        Window {
            minimum: self.config.min_overlap,
            top: self.fixed.top(),
            bottom: self.fixed.bottom(),
        }
    }

    /// 复核 cols 在 pos 处与长图的重叠，excluded 为旧固定带，返回误差及长度。
    pub(crate) fn known_diff(
        &self,
        cols: &Signature,
        pos: i32,
        excluded: (i32, i32),
    ) -> (f32, i32) {
        overlap_diff(
            &self.long.cols,
            cols,
            pos,
            self.window(),
            excluded,
            &self.motion.weights,
        )
    }

    /// 判断 pos 对 height 高帧是否在锚点可达范围内；返回可达性。
    pub(crate) fn reachable(&self, pos: i32, height: i32) -> bool {
        (pos - self.anchor).abs() <= height - self.config.min_overlap
    }
}
